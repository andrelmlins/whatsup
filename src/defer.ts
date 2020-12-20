import { Delegation } from './stream'
import { Context } from './context'

export interface DeferActor<A> {
    (arg: A): void
    break(): void
}

export type DefGenerator<T, A> = (context: Context, arg: A) => Generator<T>
export type Resolver<T, A> = (arg: A) => T | Delegation<T>

export class Defer<T, A> {
    private readonly resolver: Resolver<T, A>
    private breaked = false

    constructor(resolver: Resolver<T, A>) {
        this.resolver = resolver
    }

    actor() {
        const fn = (arg: A) => this.resolve(arg)

        Object.defineProperties(fn, {
            break: {
                value: () => this.break(),
            },
        })

        return (fn as any) as DeferActor<A>
    }

    resolve(arg: A) {
        if (this.breaked) {
            throw 'Already breaked'
        }

        return this.resolver(arg)
    }

    break() {
        this.breaked = true
    }
}
