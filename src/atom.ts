import { StreamIterator, Stream, DelegatingStream, Delegation } from './stream'
import { Context } from './context'
import { Dependencies } from './dependencies'
import { ConsumerQuery, Query } from './query'
import { Mutator } from './mutator'
import { SCHEDULER } from './scheduler'
import { ErrorCache, DataCache } from './cache'
import { Stack } from './stack'
import { DefGenerator, DeferActor, Defer } from './defer'

export class Atom<T = any> {
    private readonly stream: Stream<T>
    private readonly context: Context
    private readonly stack: Stack<StreamIterator<T>>
    private readonly consumers: Set<Atom>
    private readonly dependencies: Dependencies
    private readonly delegations: WeakMap<Stream<any>, Delegation<T>>
    private readonly deferred: Map<DefGenerator<any, any>, DeferActor<any>>
    private cache: ErrorCache | DataCache<T | Delegation<T>> | undefined

    constructor(stream: Stream<T>, parentContext: Context | null = null) {
        this.stream = stream
        this.context = new Context(this, parentContext)
        this.consumers = new Set()
        this.stack = new Stack()
        this.dependencies = new Dependencies(this)
        this.delegations = new WeakMap()
        this.deferred = new Map()
    }

    addConsumer(consumer: Atom) {
        this.consumers.add(consumer)
    }

    getConsumers() {
        return this.consumers
    }

    getContext() {
        return this.context
    }

    getCache() {
        return this.cache
    }

    getCacheValue() {
        return this.cache && this.cache.value
    }

    update() {
        SCHEDULER.run((transaction) => transaction.add(this))
    }

    defer<U, A>(generator: DefGenerator<U, A>) {
        if (this.deferred.has(generator)) {
            return this.deferred.get(generator)!
        }

        const defer = new Defer<U, A>((arg: A) => this.exec(generator, arg))
        const actor = defer.actor()

        this.deferred.set(generator, actor)

        return actor
    }

    exec<U, A>(generator: DefGenerator<U, A>, arg: A): U | Delegation<U> {
        this.deferred.delete(generator)

        const { context } = this
        const stack = new Stack<StreamIterator<U>>()

        stack.push(generator(context, arg))

        let input: any

        while (true) {
            try {
                const { done, value } = stack.last.next(input)

                if (done) {
                    stack.pop()

                    if (!stack.empty) {
                        input = value
                        continue
                    }

                    return (this.prepareNewData(value as any) as any) as U | Delegation<U>
                }
                if (value instanceof ConsumerQuery) {
                    input = this
                    continue
                }
                if (value instanceof Atom) {
                    const { stream } = value

                    const result = value.exec(function* () {
                        const iterator = stream.iterate(context)
                        let input: any

                        while (true) {
                            const { done, value } = iterator.next(input)

                            if (done) {
                                return value
                            }
                            if (value instanceof Query || value instanceof Atom) {
                                input = yield value
                                continue
                            }

                            return value
                        }
                    }, null)

                    if (result instanceof Delegation) {
                        const iterator = result[Symbol.iterator]() as StreamIterator<U>
                        stack.push(iterator)
                        input = undefined
                    } else {
                        input = result
                    }

                    continue
                }

                throw 'Unknown value'
            } catch (error) {
                stack.pop()!.return!()
                throw error
            }
        }
    }

    break<U, A>(generator: DefGenerator<U, A>) {
        if (this.deferred.has(generator)) {
            const defer = this.deferred.get(generator)!

            defer.break()

            this.deferred.delete(generator)

            return true
        }
        return false
    }

    dispose(initiator?: Atom) {
        if (initiator) {
            this.consumers.delete(initiator)
        }
        if (this.consumers.size === 0) {
            this.cache = undefined
            this.context.dispose()
            this.dependencies.dispose()

            while (!this.stack.empty) {
                this.stack.pop()!.return!()
            }

            for (const [_, actor] of this.deferred) {
                actor.break()
            }

            this.deferred.clear()
        }
    }

    *[Symbol.iterator](): Generator<never, T, any> {
        //        this is ^^^^^^^^^^^^^^^^^^^^^^^^ for better type inference
        //        really is Generator<this | Query, T, any>

        if (this.cache instanceof ErrorCache) {
            throw yield this as never
        }

        return yield this as never
    }

    buildIfNeeded() {
        if (!this.cache) {
            this.build()
        }
    }

    build() {
        const { stack, dependencies, context, stream } = this

        dependencies.swap()

        if (stack.empty) {
            stack.push(stream.iterate(context))
        }

        let input: any

        while (true) {
            try {
                const { done, value } = stack.last.next(input)

                if (done) {
                    stack.pop()

                    if (!stack.empty) {
                        input = value
                        continue
                    }
                }
                if (value instanceof ConsumerQuery) {
                    input = this
                    continue
                }
                if (value instanceof Atom) {
                    value.buildIfNeeded()

                    const cacheValue = value.getCacheValue()

                    if (cacheValue instanceof Delegation) {
                        const iterator = cacheValue[Symbol.iterator]()
                        this.stack.push(iterator)
                        input = undefined
                    } else {
                        input = cacheValue
                    }

                    dependencies.add(value)
                    continue
                }

                const data = this.prepareNewData(value)
                this.cache = new DataCache(data)
            } catch (error) {
                stack.pop()
                this.cache = new ErrorCache(error)
            }

            dependencies.disposeUnused()
            return
        }
    }

    private prepareNewData(value: T): T | Delegation<T> {
        if (value instanceof Mutator) {
            const oldValue = this.getCacheValue()
            const newValue = value.mutate(oldValue) as T
            return newValue
        }

        if (value instanceof Stream && this.stream instanceof DelegatingStream) {
            return this.getDelegation(value)
        }

        return value
    }

    private getDelegation(stream: Stream<any>) {
        if (!this.delegations.has(stream)) {
            const delegation = new Delegation(stream, this.context)
            this.delegations.set(stream, delegation)
        }
        return this.delegations.get(stream)!
    }
}
