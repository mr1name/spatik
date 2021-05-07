import * as bin from "./binarizer";
import { Vector } from "./immutable";

export type BoundRef<T extends Model> = T | Ref | string;

@bin.serializable('spatik.Ref')
export class Ref { 
    @bin.property(0) protected _id: string;

    constructor(id: string) { this._id = id; } 

    equal(other: BoundRef<any>): boolean { 
        return this._id == Ref.id(other); 
    }

    static id<T extends Model>(ref: BoundRef<T>): string { 
        return ref instanceof Ref ? (ref as Ref)._id : ref; 
    }

    static from<T extends Model>(ref: BoundRef<T>) { 
        return new Ref(Ref.id(ref)) as BoundRef<T>; 
    }
}

export const none = new bin.Token('spatik.none');

interface KeyStream {
    next(): string;
}

@bin.serializable('spatik.LinearKeyStream')
class LinearKeyStream {
    @bin.property(0) private _index: number;

    constructor(index: number) { 
        this._index = index; 
    }
 
    next() { 
        this._index++; 
        return `@${this._index.toString(36)}`; 
    }
}

@bin.serializable('spatik.World')
export class World {
    @bin.property(0) protected _parent: World | undefined;
    @bin.property(1) protected _models: Map<string, Model>;
    @bin.property(2) protected _keyStream: KeyStream;
    @bin.property(3) protected _children: Set<World>;
    @bin.property(4) protected _locked: boolean;
    @bin.property(5) protected _lookupCache?: LookupCache;

    protected static _lookupCacheFactor = 64;

    constructor(parent?: World) {
        this._parent = parent;
        this._models = new Map();
        this._keyStream = parent ? 
            parent._keyStream : new LinearKeyStream(0);
        this._children = new Set();
        if (this._parent)
            this._parent._children.add(this);
        this._locked = false;
        this._lookupCache = undefined;
    }

    get parent() { return this._parent; }
    set parent(parent: World) {
        this.detach();
        this._parent = parent;
        parent._children.add(this);
    }

    create<T extends Model>(constructor: ModelClass<T>, ...parameters: ModelParameters<T>) {
        constructor = Model.getConstructor(constructor);
        const model = this._add(this._keyStream.next(), constructor);
        model.init(...parameters);
        return model;
    }

    bind<T extends Model>(ref: BoundRef<T>): T { 
        if (!ref)
            return undefined;
        const _ = this._mustFindNearest(ref);
        if (_.world === this)
            return _;
        const constructor = Model.constructorOf(_);
        return this._add(ref, constructor);
    }

    constructorOf<T extends Model>(ref: BoundRef<T>): ModelConstructor<T> | undefined {
        const _ = this._findNearest(ref);
        if (!_)
           return undefined;
        return Model.constructorOf(_);
    } 

    commit() {
        if (!this._parent)
            return;
        if (this._parent.locked && this._parent._children.size > 1)
            throw new Error(`World.commit: parent world is locked and have more than 1 children!`);

        const nonCommitableModelError = (_: any) =>
            `Model "${_._id}" failed serializability check!`;

        for (let model of this._models.values()) 
            if (!model.committable())
                throw new Error(nonCommitableModelError(model));

        for (let model of this._models.values()) 
            model.commit();
    }

    detach() {
        if (!this._parent)
            return;
        this._parent._children.delete(this);
        this._parent = undefined;
    }

    get locked() { return this._locked; }

    lock() {
        let world: World | undefined = this;
        while(world && !world.locked) {
            world._locked = true;
            world = world.parent;
        }
        this._requestLookupCache();
    }

    unlock() {
        if (!this.locked)
            return;
        const queue: World[] = [this];
        while (queue.length > 0) {
            const _ = queue.pop();
            if (!_.locked)
                continue;
            _._locked = false;
            _._lookupCache = undefined;
            _._children.forEach(_ => queue.push(_));
        }
    }

    _add<T extends Model>(ref: BoundRef<T>, constructor: ModelConstructor<T>) {
        const id = Ref.id(ref);
        const model = new constructor(id, this);
        this._models.set(id, model);
        return model;
    }

    _findOwn<T extends Model>(ref: BoundRef<T>) {
        return this._models.get(Ref.id(ref)) as T | undefined;
    }

    _findNearest<T extends Model>(ref: BoundRef<T>): T | undefined {
        let world: World = this;
        while(world) {
            const own = world._findOwn(ref);
            if (own)
                return own as T;
            if (world.locked && world._lookupCache) 
                return world._lookupCache.getBinding(ref);
            world = world._parent;
        }
        return undefined;
    }

    _mustFindNearest<T extends Model>(ref: BoundRef<T>): T {
        const _ = this._findNearest(ref);
        if (!_)
            throw new Error(`Unknown reference ${Ref.id(ref)}!`);
        return _;
    }

    _getOwnSlot<T extends Model>(ref: BoundRef<T>, index: number) {
        const model = this._findOwn(ref);
        if (!model) 
            return none;
        return model.getOwnSlot(index)
    }

    _getSlot<T extends Model>(ref: BoundRef<T>, index: number) {
        let world: World = this;
        while (world) {
            const own = world._getOwnSlot(ref, index);
            if (own !== none)
                return own;
            if (world.locked && world._lookupCache) 
                return world._lookupCache.getSlot(ref, index);
            world = world.parent;
        }
        return undefined;
    }

    _hasWrites<T extends Model>(ref: BoundRef<T>) {
        const own = this._findOwn(ref);
        if (!own)
            return false;
    }

    private _requestLookupCache() {
        if (!this.locked)
            return;

        const path: World[] = [];
        let world: World = this.parent;
        while(world && !world._lookupCache) {
            path.push(world);
            world = world._parent;
        }

        if (path.length < World._lookupCacheFactor)
            return;

        let cache: LookupCache; 
        if (world) {
            cache = world._lookupCache;
            world._lookupCache = undefined;
            path.push(world); 
        } else cache = new LookupCache();

        while(path.length > 0) {
            const world = path.pop();
            world._models.forEach(p => cache.put(p));
        }

        this._lookupCache = cache;
    }
}

type RemoteProxyOut<T> = T extends Model ? RemoteProxy<T> : T;

export type RemoteProxy<T extends Model> = Ref & {
    readonly [K in keyof T]: T[K] extends (...args: infer P) => infer R ? 
        (K extends keyof T['proxyOptions'] ? 
            ('pure' extends T['proxyOptions'][K] ? 
                (...args: P) => RemoteProxyOut<R> : never) :
            (...args: P) => Promise<RemoteProxyOut<R>>) :
        RemoteProxyOut<T[K]>;
}

type AnyProxyOut<T> = T extends Model ? AnyProxy<T> : T;

export type AnyProxy<T extends Model> = Ref & {
    readonly [K in keyof T]: T[K] extends (...args: infer P) => infer R ? 
        (K extends keyof T['proxyOptions'] ? 
            ('pure' extends T['proxyOptions'][K] ? 
                (...args: P) => AnyProxyOut<R> : never) :
            (...args: P) => AnyProxyOut<R> | Promise<AnyProxyOut<R>>) :
        AnyProxyOut<T[K]>;
}

export type SlotOptions = {type?: string | Function, index?: number};
export type SlotMap = {[key: string]: SlotOptions};

export type Pure<T> = T & {__pure: T};

export interface ModelConstructor<T extends Model> {
    new(id: string, world: World): T;
    modelName: string;
    register(name: string): void;
    slots: SlotMap;
    slotCount: number;
}

export type ModelClass<T extends Model> = string | ModelConstructor<T>;
export type ModelParameters<T extends Model> = Parameters<T['init']>;

@bin.serializable('spatik.Model')
export class Model extends Ref {
    @bin.property(0) private readonly _world: World;
    @bin.property(1) private _reads:  any[];
    @bin.property(2) private _writes: any[];

    constructor(id: string, world: World) {
        super(id);
        this._world  = world;
        
        const size: number = Object.getPrototypeOf(this).constructor.slotCount;
        this._reads  = new Array(size);
        this._writes = new Array(size);
        
        for (var i = 0; i < size; i++) {
            this._reads [i] = none;
            this._writes[i] = none;
        }
    }

    init(..._parameters: any[]) { /* nothing to do... */ };

    get world() { return this._world; };    
    get slotCount() { return this._reads.length; }

    getOwnSlot(index: number) {
        if (index >= this.slotCount)
            return none;
        if (this._writes[index] !== none)
            return this._upcast(this._writes[index]);
        if (this._reads[index] !== none)
            return this._upcast(this._reads[index]);
        return none;
    }

    getOwnSlots() {
        const slots = this._reads.slice();
        for (var i = 0; i < this._writes.length; i++) {
            if (this._writes[i] == none)
                continue;
            slots[i] = this._writes[i];
        }
        return slots;
    }

    isModified() {
        for (var i = 0; i< this.slotCount; i++)
            if (this._writes[i] !== none)
                return true;
        return false;
    }

    private _getParentSlot(index: number) {
        if (this._world.parent)
            return this._world.parent._getSlot(this, index);
        return undefined;
    }

    private _readSlot(index: number) {
        if (index >= this.slotCount)
            return undefined;
        let _ = this.getOwnSlot(index);
        if (_ !== none)
            return _;
        _ = this._getParentSlot(index);
        this._reads[index] = this._downcast(_);
        return this._upcast(_);
    }

    private _writeSlot(index: number, _: any) {
        if (index >= this.slotCount)
            return undefined;
        if (this._world.locked)
            throw new Error(`Model._writeSlot: cannot write property in locked world!`);
        this._writes[index] = this._downcast(_);
        return this._upcast(_);
    }

    private _upcast(_: any) { 
        if (_ instanceof Ref)
            return this._world.bind(_);
        return _; 
    }

    private _downcast(_: any) { 
        if (_ instanceof Ref)
            return Ref.from(_);
        return _; 
    }

    committable() {
        if (!this._world.parent)
            return true;
        const parent = this._world.parent._findOwn(this);
        if (!parent)
            return true;
        for (var i = 0; i < this.slotCount; i++) {
            if (this._reads[i] === none)
                continue;
            const my = this._upcast(this._reads[i]);
            const other = parent.getOwnSlot(i);
            if (my instanceof Ref && !my.equal(other)) 
                return false;
            if (my != other)
                return false;
        }
        return true;
    }

    commit() {
        if (!this._world.parent)
            return;

        let parent = this._world.parent._findOwn(this);
        if (!parent) {
            const constructor = Model.constructorOf(this);
            parent = this._world.parent._add(this, constructor);
        }

        for (var i = 0; i < this._writes.length; i++) {
            if (this._writes[i] === none)
                continue;
            const update = this._upcast(this._writes[i]);
            parent._writes[i] = this._downcast(update);
            this._writes[i] = none;
        }

        for (var i = 0; i < this.slotCount; i++) {
            if (parent._reads[i] !== none)
                continue;
            const update = this._upcast(this._reads[i]);
            parent._reads[i] = this._downcast(update);
            this._reads[i] = none;
        }
    }

    proxyOptions?: {};

    static constructorOf(obj: object) {
        if (!(obj instanceof Model))
            return undefined;
        return Object.getPrototypeOf(obj).constructor;
    }

    static _constructors: Map<string, ModelConstructor<any>> = new Map();
    static modelName: string = 'Model';

    static get slots(): SlotMap { return {} };

    static getConstructor<T extends Model>(mclass: ModelClass<T>): ModelConstructor<T> {
        return typeof mclass == 'string' ? Model._constructors.get(mclass) : mclass;
    }

    static slotCount = 0;

    static register(name: string) {
        this.modelName = name;
        let offset = 0;
        let prototype = Object.getPrototypeOf(this.prototype);
        while (prototype instanceof Model) {
            offset += (prototype.constructor as ModelConstructor<any>).slotCount;
            prototype = Object.getPrototypeOf(prototype);
        }
        Object.keys(this.slots).
            forEach((k, i) => this.defineSlot(k, i+offset, this.slots[k]));
        Model._constructors.set(name, this);
        bin.Custom.register(this, name);
    }

    static defineSlot(name: string, index: number, options: SlotOptions) {
        options.index = index;
        
        if (this.slotCount <= index)
            this.slotCount = index + 1;

        let typematch = (_: any) => true;
        const type = options.type;
        switch (typeof type) {
            case 'string':   typematch = _ => typeof _ ==  type; break;
            case 'function': typematch = _ => _ instanceof type; break;
        }
        
        const stringlifyTypeError = (_: any) => {
            const slotName = `${stringlifySlotType(this)}.${name}`;
            const typeWant = stringlifySlotType(type as ModelClass<any>);
            const typeGot  = stringlifySlotValue(_);  
            return `${slotName} (${typeWant}) cannot be assigned to (${typeGot})!`;
        }

        const get = function() {
            return (this as Model)._readSlot(index);
        }
        const set = function<T>(_: T) {
            if (!typematch(this._upcast(_)))
                throw new Error(stringlifyTypeError(_));
            return (this as Model)._writeSlot(index, _);
        }

        Object.defineProperty(this.prototype, name, {get, set});
    }
}

function stringlifySlotType<T extends Model>(_: ModelClass<T>) {
    switch (typeof _) {
        case 'string':   return _; 
        case 'function': return _.modelName || _.name; 
    }
}

function stringlifySlotValue(_: any) {
    switch (typeof _) {
        case 'string': return 'string';
        case 'number': return _;
    }
    return stringlifySlotType(Object.getPrototypeOf(_).constructor);
}

@bin.serializable('spatik.LookupCache', bin.FixedCoder(undefined))
class LookupCache {
    private _cache: Map<string, {model: Model, slots: any[]}>;

    constructor() {
        this._cache = new Map();
    }

    merge(cache: LookupCache) {
        cache._cache.forEach((v, k) => 
            this._cache.set(k, {model: v.model, slots: v.slots}));
    }

    put(model: Model) {
        const id = Ref.id(model);
        if (!this._cache.has(id)) {
            this._cache.set(id, {
                model, 
                slots: model.getOwnSlots()});
            return;
        }
        const entry = this._cache.get(id);
        entry.model = model;
        for (var i = 0; i < model.slotCount; i++) {
            const _ = model.getOwnSlot(i);
            if (_ !== none)
                entry.slots[i] = _;
        }
    }

    getSlot<T extends Model>(ref: BoundRef<T>, i: number) {
        const entry = this._cache.get(Ref.id(ref));
        if (entry)
            return entry.slots[i];
        return undefined;
    }

    getBinding<T extends Model>(ref: BoundRef<T>): T | undefined {
        const entry = this._cache.get(Ref.id(ref));
        if (entry)
            return entry.model as T;
        return undefined;
    }
}

export interface Subscription {
    unsubscribe(): void;
}

@bin.serializable('spatik.Stream', bin.FixedCoder(() => new Stream()))
class Stream<T> {
    private _subscribers: ((next: T) => void)[];
    private _current: T | undefined;

    constructor() {
        this._subscribers = [];
        this._current = undefined;
    }

    push(next: T) {
        this._current = next;
        for (var i = 0; i < this._subscribers.length; i++)
            this._subscribers[i](next);
    }

    subscribe(fn: (next: T) => void): Subscription {
        const wrapper = (next: T) => fn(next);
        this._subscribers.push(wrapper);
        const unsubscribe = () => 
            this._subscribers.splice(this._subscribers.indexOf(wrapper), 1);
        if (this._current !== undefined)
            wrapper(this._current);
        return {unsubscribe};
    }
}

@bin.serializable('spatik.App')
export class App {
    @bin.property(0) protected _worlds: World[];
    @bin.property(1) protected _redo: World[];

    constructor(world?: World) {
        if (!world)
            world = new World();
        this._worlds = [world];
        this._redo = [];
    }

    get _world() { return this._worlds[this._worlds.length-1]; }

    advance() {
        this._cleanRedoBuffer();
        this._world.lock();
        this._worlds.push(new World(this._world));
    }

    undo() {
        if (this._worlds.length <= 1)
            return;
        this._redo.push(this._worlds.pop());
        this._world.unlock();
    }

    redo() {
        if (this._redo.length < 1)
            return;
        this._world.lock();
        this._worlds.push(this._redo.pop());
    }

    flatten() {
        if (this._worlds.length <= 1)
            return;
        this._cleanRedoBuffer();
        this._worlds[0].unlock();
        while (this._worlds.length > 1) {
            const world  = this._worlds.pop();
            world.commit();
        }
    }

    protected _cleanRedoBuffer() {
        this._redo.forEach(w => w.detach());
        this._redo = [];
    }
}

export interface WaveMergeOptions {
    tag: string;
    rate?: number;
}

export const waveMerge = (tag: string, rate?: number) =>
    (target: any, property: string, descriptor: PropertyDescriptor) => {
        target[property]._waveMergeOptions = {tag, rate};
    }

@bin.serializable('spatik.WaveMergeState')
class WaveMergeState {
    @bin.property(0) private _tag: string[];
    @bin.property(1) private _rate: number;
    
    constructor(tag: string[], rate: number) {
        this._tag = tag;
        this._rate = rate;
    }

    private _parseTag(id: string, tagString: string, rate?: number): string[] {
        const tag = tagString.split(':');
        for (var i = 0; i < tag.length; i++) switch(tag[i]) {
        case 'id':   tag[i] = id; break;
        case 'rate': tag[i] = rate !== undefined ? 
            rate.toString() : '*'; break;
        }
        return tag;
    }

    private _canMerge(tag: string[], rate?: number): boolean {
        if (rate <= this._rate)
            return false;
        if (tag.length != this._tag.length)
            return false;
        for (var i = 0; i < tag.length; i++)
            if (tag[i] != '*' && tag[i] != this._tag[i])
                return false;
        return true;
    }

    merge(id: string, tagString: string, rate?: number): boolean {
        const tag = this._parseTag(id, tagString, rate);
        if (!this._canMerge(tag, rate)) {
            this._tag = tag;
            this._rate = 1;
            return false;
        } 
        this._tag = tag;
        this._rate = this._rate + 1;
        return true;
    }
}

export type PropertiesOf<T, C = any> = {[K in keyof T]: T[K] extends C ? T[K] : never};
export type MethodsOf<T> = PropertiesOf<T, (...args: any) => any>;
export type MethodKey<T> = keyof MethodsOf<T>;
export type MethodParameters<T, K extends keyof MethodsOf<T>> = 
    T[K] extends (...args: infer P) => any ? P : never;
export type MethodReturnType<T, K extends keyof MethodsOf<T>> = ReturnType<MethodsOf<T>[K]>;

export interface AnyWaveApp {
    bind  <T extends Model>(ref: BoundRef<T>): AnyProxy<T>;
    create<T extends Model>(constructor: ModelClass<T>, ...parameters: ModelParameters<T>): Promise<AnyProxy<T>> | T;
    watch <T extends Model>(ref: BoundRef<T>, fn: () => void): Subscription;
    undo(): Promise<void> | void;
    redo(): Promise<void> | void;
}

@bin.serializable('spatik.WaveApp')
export class WaveApp extends App {
    @bin.property(0) protected _mutations: Stream<World>;
    @bin.property(1) protected _waveMergeState: WaveMergeState;

    constructor(world?: World) {
        super(world)
        this._mutations = new Stream();
        this._waveMergeState = new WaveMergeState(['*'], 0);
    }

    get<T extends Model, K extends keyof T>(ref: BoundRef<T>, property: K): T[K] {
        if (property == '_id')
            return Ref.id(ref) as any;

        const model = this._world._mustFindNearest(ref);
            
        let master: Object = model;
        let descriptor: PropertyDescriptor | undefined = undefined;
        while (master) {
            descriptor = Object.
                getOwnPropertyDescriptor(master, property);
            if (descriptor)
                break;
            master = Object.getPrototypeOf(master);
        }

        if (!descriptor)
            return undefined;
        if (!descriptor.get && !descriptor.set) {
            const _ = descriptor.value;
            if (typeof _ != 'function')
                return this._upcast(_);
            const fn = (...parameters: any[]) => 
                this.call(ref, property, ...parameters as any);
            (fn as any).pure = _.pure;
            return fn as any;
        }
        
        const constructor = master.constructor as ModelConstructor<T>;
        const index = constructor?.slots[property as string]?.index;
        
        const value = index !== undefined ?
            this._world._getSlot(ref, index) :
            (model as any)[property];

        return this._upcast(value);
    }

    bind<T extends Model>(ref: BoundRef<T>): T {
        const target = Ref.from(ref);
        const app = this;
        const proxy = new Proxy(target as any, {
            get: app.get.bind(app),
            set(ref: BoundRef<T>, property, value) {
                app.advance();
                const model = app._world.bind(ref);
                return (model as any)[property] = value;
            },
            getPrototypeOf(ref: BoundRef<T>) {
                return app._world.constructorOf(ref).prototype;
            },
        });
        return proxy as T;
    }

    call<T extends Model, K extends MethodKey<T>>(ref: BoundRef<T>, property: K, ...parameters: MethodParameters<T, K>): MethodReturnType<T, K> {
        const constructor = this._world.constructorOf(ref);
        const method = constructor.prototype[property];

        const options: WaveMergeOptions = method?._waveMergeOptions;

        if (!method.pure) 
            if (options) this._advanceWaveMerge(Ref.id(ref), options);
            else         this.advance();

        const model = this._world.bind(ref);

        const _ = (model as MethodsOf<T>)[property](...parameters);
        
        if (!method.pure)
            this._mutations.push(this._world);

        return this._upcast(_);   
    }

    create<T extends Model>(constructor: ModelClass<T>, ...parameters: ModelParameters<T>) {
        this._advanceWaveMerge('*', {tag: 'this.init', rate: 0});
        const  _ = this._world.create(constructor, ...parameters);
        this._mutations.push(this._world);
        return this.bind<T>(Ref.from(_));
    }

    watch<T extends Model>(ref: BoundRef<T>, fn: () => void): Subscription {
        const filter = (world: World) => {
            const model = world._findOwn(ref);
            if (!model || !model.isModified())
                return;
            return fn();
        }
        return this._mutations.subscribe(filter);
    }

    undo() {
        const world = this._world;
        super.undo();
        if (world !== this._world) {
            this._waveMergeState.merge('*', 'undo', 0);
            this._mutations.push(this._world);
        }
    }

    redo() {
        const world = this._world;
        super.redo();
        if (world !== this._world) {
            this._waveMergeState.merge('*', 'undo', 0);
            this._mutations.push(this._world);
        }
    }

    private _upcast<T>(_: T) {
        if (_ instanceof Model)
            return this.bind(_);
        return _;
    }

    private _advanceWaveMerge(id: string, options: WaveMergeOptions) {
        if (this._waveMergeState.merge(id, options.tag, options.rate)) {
            this._cleanRedoBuffer();
            return;
        }
        this.advance();
    }

}

export const model = (name: string) => (target: ModelConstructor<any>) => 
    target.register(name);

export const slot = (options?: SlotOptions) => 
    (target: any, key: string) => {
        if (!target.constructor.hasOwnProperty('slots')) {
            const get = () => target.constructor._slots;
            Object.defineProperty(target.constructor, 'slots', {get});
            target.constructor._slots = {};
        }
        target.constructor._slots[key] = options ?
            {type: options.type} : {};
    }


export const pure = (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    descriptor.value.pure = true;
};