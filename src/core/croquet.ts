import {BoundRef, WaveApp, Model, ModelClass, ModelParameters, Ref, RemoteProxy, Subscription} from './model';
import * as bin from './binarizer';

function getRandomInt(min: number, max: number) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fetchScript(url: string) {
    return new Promise<Event>((resolve, reject) => {
        const node = document.createElement('script');
        node.src = url;
        node.onload = (event) => resolve(event);
        node.onerror = () => reject();
        document.head.appendChild(node);
    });
}

const _fetchScriptOncePromises = new Map<string, Promise<Event>>();

function fetchScriptOnce(url: string) {
    const _ = _fetchScriptOncePromises;
    if (!_.has(url)) 
        _.set(url, fetchScript(url));
    return _.get(url);
}

export function initCroquetLibrary() {
    return fetchScriptOnce('js/croquet.min.js');
}

declare global {
    var Croquet: any;
}

export interface RemoteWaveApp {
    bind<T extends Model>(ref: BoundRef<T>): RemoteProxy<T>;
    create<T extends Model>(constructor: ModelClass<T>, ...parameters: ModelParameters<T>): Promise<RemoteProxy<T>>;
    assign<T extends Model, K extends keyof T>(ref: BoundRef<T>, property: K, value: T[K]): Promise<T[K]>;
    watch<T extends Model>(ref: BoundRef<T>, fn: () => void): Subscription;
    undo(): Promise<void>;
    redo(): Promise<void>;
}

let _croquetIntegration: any = undefined;

export async function initCroquetInteration() {
    await initCroquetLibrary();

    type CroquetIntegration = {
        model: typeof App,
        view: typeof AppView,
    };

    type AppQuery = {
        method: string, 
        callerKey: string, 
        callKey: number, 
        parameters: any[],
    };

    if (_croquetIntegration)
        return _croquetIntegration as CroquetIntegration;

    class App extends Croquet.Model {
        app: WaveApp;

        init(_: {snapshot?: ArrayBuffer} = {}) {
            this.app = _.snapshot ? 
                bin.decode(_.snapshot) : new WaveApp();
            this.subscribe(this.id, 'query', this.handleQuery);
        }

        handleQuery(query: ArrayBuffer) {
            const _: AppQuery = bin.decode(query);
            let result = this[_.method](..._.parameters);
            this.publish(this.id, _.callerKey, [_.callKey, result]);
        }

        undo() { return this.app.undo(); }
        redo() { return this.app.redo(); }

        create<T extends Model>(constructor: ModelClass<T>, parameters: ModelParameters<T>) {
            return this.app.create(constructor, ...parameters);
        }

        assign<T extends Model, K extends keyof T>(ref: BoundRef<T>, property: K, value: T[K]): T[K] {
            return (this.app.bind(ref)[property] = value);
        }

        call<T extends Model>(ref: BoundRef<T>, method: string, parameters: any[]) {
            return (this.app.bind(ref) as any)[method](...parameters);
        }

        static types() {
            return {
                "WaveApp": {
                    cls: WaveApp,
                    write: (app: WaveApp) => bin.encode(app),
                    read:  (state: ArrayBuffer) => bin.decode(state),
                }
            }   
        }
    }
    App.register('App');

    class AppView extends Croquet.View implements RemoteWaveApp {
        private model: App;
        private promises: Map<number, any[]>;
        private callerKey: string;
        private callKey: number;

        constructor(model: App) {
            super(model);
            this.model = model;
            this.promises = new Map();
            this.callKey = 0;
            this.callerKey = getRandomInt(0, Number.MAX_SAFE_INTEGER).toString(36);
            this.subscribe(this.model.id, this.callerKey, this.handleReturn)
        }

        bind<T extends Model>(ref: BoundRef<T>): RemoteProxy<T> {
            const view = this;
            const app = this.model.app;

            ref = Ref.from(ref);
            const proxy = new Proxy(ref as Ref, {
                get(ref, property) {
                    if (property == '_id')
                        return Ref.id(ref);
                    const model = app.bind(ref);
                    const _ = (model as any)[property];
                    if (typeof _ != 'function')
                        return view._upcast(_);
                    if (_.pure) return (...args: any[]) => {
                        const value = (app.bind(ref) as any)[property](...args);
                        return view._upcast(value);
                    }
                    return (...args: any) => view.call(ref, property as string, ...args);
                },
                set(_ref, _property, _value) {
                    return false;
                },
            });
            return proxy as RemoteProxy<T>;
        }

        handleReturn(_: any[]) {
            const resolver = this.promises.get(_[0]);
            if (resolver) resolver[0](_[1]);
            this.promises.delete(_[0]);
        }

        promise(method: string, ...parameters: any[]) {
            this.callKey++;
            const tick = this.callKey;
            const promise = new Promise((resolve, reject) => 
                this.promises.set(tick, [resolve, reject]));
            const query: AppQuery = {
                method: method,
                callerKey: this.callerKey,
                callKey: tick,
                parameters: parameters.
                    map(p => p instanceof Model ? Ref.from(p) : p),
            }
            const message = bin.encode(query);
            // console.log(`message size: ${message.byteLength}`);
            this.publish(this.model.id, 'query', message);
            return promise;
        }

        private _upcast<T>(_: T) {
            if (_ instanceof Model)
                return this.bind(Ref.from(_));
            return _;
        }

        async assign<T extends Model, K extends keyof T>(ref: BoundRef<T>, property: K, value: T[K]): Promise<T[K]> {
            const _ = await this.promise('assign', Ref.id(ref), property, value) as Promise<T[K]>;
            return this._upcast(_);
        }
    
        async call<T extends Model>(ref: BoundRef<T>, method: string, ...parameters: any[]) {
            const _ = await this.promise('call', Ref.id(ref), method, parameters);
            return this._upcast(_);
        }
    
        async create<T extends Model>(constructor: ModelClass<T>, ...parameters: ModelParameters<T>) {
            if (typeof constructor != 'string')
                constructor = constructor.modelName;
            const _ = await this.promise('create', constructor, parameters) as T;
            return this._upcast(_) as RemoteProxy<T>;
        }

        watch<T extends Model>(ref: BoundRef<T>, fn: () => void): Subscription {
            return this.model.app.watch(ref, fn);
        }

        async undo(): Promise<void> {
            await this.promise('undo');
            return;
        }

        async redo(): Promise<void> {
            await this.promise('redo')
            return;
        }
    }

    _croquetIntegration = {
        model: App, 
        view: AppView
    } as CroquetIntegration;

    return _croquetIntegration as CroquetIntegration;
}

export interface Session {
    id: string;
    view: RemoteWaveApp;
    step(time: number): void;
    leave(): void;
}

interface SessionOptions {
    appId: string;
    name: string;
    password: string;
}

export async function initCroquetSession(options: SessionOptions) {
    const integration = await initCroquetInteration();
    Croquet.App.sync = false;
    return await Croquet.Session.join({
        appId: options.appId,
        name: options.name,
        password: options.password,
        autoSleep: false,
        model: integration.model,
        view: integration.view,
        
    }) as Session;
}