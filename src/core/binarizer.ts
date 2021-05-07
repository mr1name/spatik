export interface Coder<T> {
    id?: number;
    decode(_: BinaryDecoder, $: T): T;
    encode($: T, _: BinaryEncoder): void;
    predecode?: (_: BinaryDecoder) => T;
}

export interface CustomCoder<T> extends Coder<T> {
    predecode(_: BinaryDecoder): T;
    noindex?: boolean;
}

export function decode(buffer: ArrayBuffer) {
    const decoder = new BinaryDecoder(buffer);
    for (var i = 0; i < decoder.meta.objects; i++)
        decoder.next(true);
    return decoder.finish();
}

export function encode<T>(_: T) {
    const indexer = new Indexer();
    indexer.index(_);
    
    const objects = indexer.flatten();
    const indexes = new Map();
    for (var i = 0; i < objects.length; i++)
        indexes.set(objects[i], i);

    const encoder = new BinaryEncoder(indexes);
    for (var i = 0; i < objects.length; i++)
        encoder.next(objects[i], true);

    return encoder.finish(_);
}

// length (varint)
//      (type string) (type info)

export const Coders = {
    UNKNOWN: {
        id: 0x0,
        decode() { return undefined; },
        encode() { return; },
    } as Coder<undefined>,
    POINTER: {
        id: 0x1,
        decode(_) { return _.readVarint(); },
        encode($, _)  { _.pushVarint($); }
    } as Coder<number>,
    POSITIVE_INT: {
        id: 0x2,
        decode(_) { return _.readVarint(); },
        encode($, _)  { _.pushVarint($); }
    } as Coder<number>,
    NEGATIVE_INT: {
        id: 0x3,
        decode(_)     { return -(_.readVarint() + 1); },
        encode($, _)  { _.pushVarint((-$) - 1); }
    } as Coder<number>,
    FLOAT64: {
        id: 0x4,
        decode(_)     { return _.readFloat64(); },
        encode($, _)  { _.pushFloat64($); }
    } as Coder<number>,
    STRING: {
        id: 0x5,
        decode(_)     { return _.readUTF8String(); },
        encode($, _)  { _.pushUTF8String($); }
    } as Coder<string>,
    UNDEFINED: {
        id: 0x6,
        decode() { return undefined; },
        encode() { return; },
    } as Coder<undefined>,
    TRUE: {
        id: 0x7,
        decode() { return true; },
        encode() { return; },
    },
    FALSE: {
        id: 0x8,
        decode() { return false; },
        encode() { return; },
    },
    NULL: {
        id: 0x9,
        decode() { return null; },
        encode() { return; },
    } as Coder<null>,
    ARRAY: {
        id: 0xA,
        predecode(_) {
            const length = _.readVarint();
            for (var i = 0; i < length; i++)
                _.next();
            return new Array(length);
        },
        decode(_, $) {
            const length = _.readVarint();
            for (var i = 0; i < length; i++)
                $[i] = _.next();
            return $;
        },
        encode($, _) {
            _.pushVarint($.length);
            for (var i = 0; i < $.length; i++)
                _.next($[i]);
        }
    } as Coder<any[]>,
    PLAIN_OBJECT: {
        id: 0xB,
        predecode(_) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++) {
                _.next();
                _.next();
            }
            return {};
        },
        decode(_, $) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++) 
                $[_.next()] = _.next();
            return $;
        },
        encode($, _) {
            const keys = Object.keys($);
            _.pushVarint(keys.length);
            for (var i = 0; i < keys.length; i++) {
                _.next(keys[i])
                _.next($[keys[i]]);
            }
        }
    } as Coder<{[key: string]: any}>,
    OBJECT: {
        id: 0xC,
        predecode(_) {
            const tag: string = _.next();
        
            const constructor = Custom.constructorOfTag(tag);
            if (!constructor)
                throw new Error(`OBJECT.predecode: unknown tag "${tag}"!`)
            if (constructor._binaryCoder) 
                return constructor._binaryCoder.predecode(_);

            const keys = constructor._binaryKeys;
            const sizes: number[] = [];
            for (let i = 0; i < keys.length; i++)
                sizes.push(_.readVarint());

            for (var i = 0; i < sizes.length; i++) 
                for (var k = 0; k < sizes[i]; k++)
                    _.next();

            return Object.create(constructor.prototype);
        },
        decode(_, $) {
            const tag: string = _.next();
            
            const constructor = Custom.constructorOfTag(tag);
            if (constructor._binaryCoder)
                return constructor._binaryCoder.decode(_, $);

            const keys = constructor._binaryKeys;
            const sizes: number[] = [];
            for (let i = 0; i < keys.length; i++)
                sizes.push(_.readVarint());
            
            for (var i = 0; i < sizes.length; i++) 
                for (var k = 0; k < sizes[i]; k++)
                    $[keys[i][k]] = _.next();
    
            return $;
        },
        encode($, _) {
            _.next(Custom.tagOfObject($ as any));
    
            const constructor: CustomConstructor<any> = 
                Object.getPrototypeOf($).constructor;
            if (constructor._binaryCoder)
                return constructor._binaryCoder.encode($, _);

            const keys = constructor._binaryKeys;
            for (var i = 0; i < keys.length; i++)
                _.pushVarint(keys[i].length);

            for (var i = 0; i < keys.length; i++)  
                for (var k = 0; k < keys[i].length; k++)
                    _.next($[keys[i][k]]);
        }
    } as Coder<{[key: string]: any}>,
    MAP: {
        id: 0xD,
        predecode(_) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++) {
                _.next();
                _.next();
            }
            return new Map();
        },
        decode(_, $) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++) 
                $.set(_.next(), _.next());
            return $;
        },
        encode($, _) {
            _.pushVarint($.size);
            $.forEach((v, k) => { _.next(k); _.next(v); });
        },
    } as Coder<Map<any, any>>,
    SET: {
        id: 0xE,
        predecode(_) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++)
                _.next();
            return new Set();
        },
        decode(_, $) {
            const size = _.readVarint();
            for (var i = 0; i < size; i++)
                $.add(_.next());
            return $;
        },
        encode($, _) {
            _.pushVarint($.size);
            $.forEach(e => _.next(e));
        }
    } as Coder<Set<any>>,
}

const _coders: Coder<any>[] = 
    Object.values(Coders).reduce((p, c) => { p[c.id] = c; return p }, []);

export function coderOf<T>(_: T) {
    switch(typeof _) {
    case 'number':
        if (!Number.isSafeInteger(_))
            return Coders.FLOAT64;
        return _ < 0 ? 
            Coders.NEGATIVE_INT : Coders.POSITIVE_INT;
    case 'boolean':
        return _ ? Coders.TRUE : Coders.FALSE;
    case 'string':
        return Coders.STRING;
    case 'undefined':
        return Coders.UNDEFINED;
    case 'object':
        if (_ === null)
            return Coders.NULL;
        if (_ instanceof Map)
            return Coders.MAP;
        if (_ instanceof Set)
            return Coders.SET;
        if (Array.isArray(_))
            return Coders.ARRAY;
        const prototype = Object.getPrototypeOf(_);
        if (Custom.tagOfConstructor(prototype.constructor))
            return Coders.OBJECT;
        if (prototype == Object.prototype)
            return Coders.PLAIN_OBJECT;
        throw new Error(`coderOf: unknown object prototype ${prototype?.constructor?.name}`);
    case 'function':
        const tag = Custom.tagOfConstructor(_);
        if (!tag)
            throw new Error(`coderOf: unknown function ${_}`);
    }
    throw new Error(`coderOf: unknown object ${_}`);
}

interface CustomConstructor<T> extends Function {
    binaryProperties?: {[key: string]: {index: number}}
    _binaryKeys?: string[][];
    _binaryCoder?: CustomCoder<T>;
}

export const Custom = {
    _constructorToTag: new Map<CustomConstructor<any>, string>(),
    _tagToConstructor: new Map<string, CustomConstructor<any>>(),

    tagOfConstructor: (_: CustomConstructor<any>) => 
        Custom._constructorToTag.get(_),
    tagOfObject: (_: Object) =>
        Custom._constructorToTag.get(Object.getPrototypeOf(_).constructor),
    constructorOfTag: (tag: string) => 
        Custom._tagToConstructor.get(tag),

    register: (constructor: CustomConstructor<any>, tag: string, coder?: CustomCoder<any>) => {
        Custom._constructorToTag.set(constructor, tag);
        Custom._tagToConstructor.set(tag, constructor);
        if (coder)
            constructor._binaryCoder = coder;
        
        const occupied = new Set<number>();
        const properties = constructor.binaryProperties;
        const keys = [];
        if (properties) for (let key in properties) {
            const property = properties[key];
            if (occupied.has(property.index))
                throw new Error(`@bin.serializable(${tag}): trying to reuse index ${property.index}!`)
            occupied.add(property.index);
            keys[property.index] = key;
        }
        
        const inherited = Object.getPrototypeOf(constructor.prototype)?.
            constructor?._binaryKeys as string[][];
        constructor._binaryKeys = inherited ? inherited.concat([keys]) : [keys];
    }
}

Custom.register(Boolean, '@js.Boolean', {
    encode($, _) { _.next($.valueOf()); },
    predecode(_) { return new Boolean(_.next()); },
    decode(_, $) { return $; },
} as CustomCoder<Boolean>);

Custom.register(Number, '@js.Number', {
    encode($, _) { _.next($.valueOf()); },
    predecode(_) { return new Number(_.next()); },
    decode(_, $) { return $; }
} as CustomCoder<Number>);

export function FixedCoder<T>(predecode: () => T | T) {
    return {
        predecode: typeof predecode == 'function' ?
            predecode : (_) => predecode, 
        decode: (_, $) => $, 
        encode: _ => {},
        noindex: true,
    } as CustomCoder<T>;
}

export const serializable = (name: string, coder?: CustomCoder<any>) =>
    (target: Function) => Custom.register(target, name, coder);

export const property = (index: number) => (target: any, key: any) => {
    if (!target.constructor.hasOwnProperty('binaryProperties')) {
        const get = () => target.constructor._binaryProperties;
        Object.defineProperty(target.constructor, 'binaryProperties', {get});
        target.constructor._binaryProperties = {};
    }
    target.constructor._binaryProperties[key] = {index};
}

class CountMap<T> {
    private _map: Map<T, number>;

    constructor() { this._map = new Map(); }

    inc(_: T) {
        const count = (this._map.get(_) || 0) + 1;
        this._map.set(_, count);
        return count;
    }

    has(_: T) { return this._map.has(_); }

    get(_: T) { return this._map.get(_); }
    set(_: T, count: number) { this._map.set(_, count); }

    flatten() {
        const _: any[] = Array.from(this._map).
            sort((a, b) => b[1] - a[1]);
        for (var i = 0; i < _.length; i++)
            _[i] = _[i][0];
        return _;
    }

    get size() { return this._map.size; }
}

export class Indexer {
    private _refcount: CountMap<any>;
    private _queue: Object[];
    
    constructor() { 
        this._refcount = new CountMap(); 
        this._queue = [];
    }

    index<T>(_: T) { this._index(_); this._refcount.inc(_); }
    flatten(): Array<any> { return this._refcount.flatten(); }

    get size() { return this._refcount.size };

    private _index<T>(_: T) {
        this._add(_);
        while (this._queue.length > 0) {
            const _ = this._queue.pop();
            if (_ instanceof Set) 
                _.forEach(e => this._add(e));
            else if (_ instanceof Map) 
                _.forEach((v, k) => 
                    { this._add(v); this._add(k); });
            else if (Array.isArray(_))
                for (var i = 0; i < _.length; i++) 
                    this._add(_[i]);
            else {
                const constructor: CustomConstructor<any> = Object.
                    getPrototypeOf(_).constructor;
                const tag = Custom.tagOfConstructor(constructor);
                if (!tag && constructor != Object)
                    throw new Error(`Indexer: unknown object prototype ${constructor?.name}`);
                for (var key in _) {
                    if (!_.hasOwnProperty(key))
                        continue;
                    if (!tag) this._add(key); 
                    this._add((_ as any)[key]); 
                }
            }
        }
    }

    private _add<T>(_: T): void {
        switch (typeof _) {
        case 'object':
            if (this._refcount.has(_)) {
                this._refcount.inc(_);
                return;
            }
            const constructor: CustomConstructor<any> = Object.
                getPrototypeOf(_).constructor;
            const tag = Custom.tagOfConstructor(constructor);
            if (tag) 
                this._refcount.set(tag, 1000000000); // TODO
            this._refcount.inc(_);
            if (!constructor._binaryCoder?.noindex)
                this._queue.push(_);
            return;
        case 'string':
            if (_.length > 2)
                this._refcount.inc(_);
            return;
        }
    }
}

export class BinaryReader {
    protected _buffer: ArrayBuffer;
    protected _bytes: Uint8Array;
    protected _view: DataView;
    protected _offset: number;
    protected _utf8decoder: TextDecoder;

    constructor(buffer: ArrayBuffer) {
        this._buffer = buffer;
        this._bytes = new Uint8Array(buffer);
        this._view  = new DataView(buffer);
        this._offset = 0;
        
        this._utf8decoder = new TextDecoder();
    }

    readUint8() {
        const value = this._view.getUint8(this._offset);
        this._offset++;
        return value;
    }

    readFloat64() {
        const value = this._view.getFloat64(this._offset);
        this._offset += 8;
        return value;
    }

    readUTF8String() {
        var index = this._offset;
        for (index; index < this._bytes.length; index++)
            if (this._bytes[index] == 0) break;
        const string = this._utf8decoder.
            decode(this._bytes.subarray(this._offset, index));
        this._offset = index + 1;
        return string;
    }
    
    readVarint() {
        var number = 0, shift = 0;
        do {
            if (shift > 49)
                throw new RangeError('varint.decode: invalid varint encoding!');
            var byte = this.readUint8();
            number += shift < 28 ?
                (byte & 0x7F) << shift :
                (byte & 0x7F) * Math.pow(2, shift);
            shift += 7;
        } while(byte >= 0x80);
        return number;
    }
}

export class BinaryWriter {
    protected _offset: number;
    protected _buffer: ArrayBuffer;
    protected _view: DataView;
    protected _size: number;

    constructor(size = 0) {
        this._offset = 0;
        this.resize(size);
    }

    get Uint8Array() { return new Uint8Array(this._buffer, 0, this._offset); }

    resize(newSize = 0) {
        this._buffer = this._buffer ?
            ArrayBuffer.transfer(this._buffer, newSize) 
            : new ArrayBuffer(newSize);
        this._view = new DataView(this._buffer);
        this._size = newSize;
    }

    fit(byteCount: number) {
        if (this._offset + byteCount < this._size)
            return;
        let newSize = this._size > 0 ? this._size * 2 : 2;
        while (newSize < this._offset + byteCount)
            newSize *= 2;
        this.resize(newSize);
    }

    pushUint8(number: number) {
        this.fit(1);
        this._view.setUint8(this._offset, number);
        this._offset++;
    }

    pushFloat64(number: number) {
        this.fit(8);
        this._view.setFloat64(this._offset, number);
        this._offset += 8;
    }

    pushUTF8String(string: string) {
        for (var i = 0; i < string.length; i++) {
            var u = string.charCodeAt(i);
            if (u >= 0xD800 && u <= 0xDFFF) {
                var u1 = string.charCodeAt(++i);
                u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
            }
            if (u <= 0x7F) {
                this.pushUint8(u);
            } else if (u <= 0x7FF) {
                this.pushUint8(0xC0 | (u >> 6));
                this.pushUint8(0x80 | (u & 63));
            } else if (u <= 0xFFFF) {
                this.pushUint8(0xE0 | (u >> 12));
                this.pushUint8(0x80 | ((u >> 6) & 63));
                this.pushUint8(0x80 | (u & 63));
            } else {
                this.pushUint8(0xF0 | (u >> 18));
                this.pushUint8(0x80 | ((u >> 12) & 63));
                this.pushUint8(0x80 | ((u >> 6) & 63));
                this.pushUint8(0x80 | (u & 63));
            }
        }
        this.pushUint8(0);
    }

    pushVarint(number: number) {
        if (Number.MAX_SAFE_INTEGER && number > Number.MAX_SAFE_INTEGER)
            throw new RangeError('BinaryWriter.pushVarint: number must be safe integer!');
        while(number > 0x80000000) {
            this.pushUint8((number & 0xFF) | 0x80);
            number /= 128; 
        }
        while (number & ~0x7F) {
            this.pushUint8((number & 0xFF) | 0x80);
            number >>>= 7;
        }
        this.pushUint8(number | 0);   
    }
}

export type MetaEncoding = {
    readonly atoms: number;
    readonly objects: number;
    readonly root: number; 
    readonly byteLength: number;
}

export type HeadEncoding = {
    readonly flags: Uint8Array; 
    readonly offset: number;
    readonly byteLength: number;
}

export class BinaryDecoder extends BinaryReader {
    readonly meta: MetaEncoding;
    readonly head: HeadEncoding;

    protected _decoded: any[];
    protected _donePredecoding: boolean;

    protected   _atomIndex: number;
    protected _objectIndex: number;

    constructor(buffer: ArrayBuffer) {
        super(buffer);

        this.meta = {
            atoms:   this.readVarint(),
            objects: this.readVarint(),
            root:    this.readVarint(),
            byteLength: this._offset,
        };
        const headByteLength = ~~(this.meta.atoms / 2) + 
            (this.meta.atoms % 2 != 0 ? 1 : 0);
        this.head = {
            flags: new Uint8Array(
                this._buffer, this.meta.byteLength, headByteLength),   
            offset: this.meta.byteLength,
            byteLength: headByteLength,
        };

        this._decoded = [];
        this._donePredecoding = false;

        this._atomIndex   = 0;
        this._objectIndex = 0;

        this._offset = this.head.offset + this.head.byteLength;
    }

    coderByIndex(index: number) {
        const shift = index % 2 != 0 ? 4 : 0;
        const id = (this.head.flags[~~(index / 2)] & (0xF << shift)) >> shift;
        return _coders[id];
    }

    predecodeNext(isObject = false) {
        const coder = this.coderByIndex(this._atomIndex);

        this._atomIndex++;
        const decodeIndex = this._objectIndex;
        if (isObject)
            this._objectIndex++;

        let _ = coder.predecode ? coder.predecode(this) : 
            coder.decode(this, 0);
        if (isObject) 
            this._decoded[decodeIndex] = _;

        if (coder === Coders.POINTER && _ < this._decoded.length)
            _ = this._decoded[_ as number];

        return _;
    }

    decodeNext(isObject = false) {
        const coder = this.coderByIndex(this._atomIndex);
        const predecoded = this._decoded[this._objectIndex];

        this._atomIndex++;
        if (isObject)
            this._objectIndex++;

        if (coder === Coders.POINTER)
            return this._decoded[coder.decode(this, 0)];

        return coder.decode(this, predecoded);
    }

    next(isObject = false) { 
        if (this._donePredecoding)
            return this.decodeNext(isObject); 
        return this.predecodeNext(isObject)
    }
    
    finish() { 
        if (this._donePredecoding)
            return;
        
        this._donePredecoding = true;
        const predecodedCount = this._objectIndex;
        
        this._atomIndex = 0;
        this._objectIndex = 0;

        this._offset = this.head.offset + this.head.byteLength;

        for (var i = 0; i < predecodedCount; i++)
            this.next(true);

        return this._decoded[this.meta.root]; 
    }
}

export class BinaryEncoder extends BinaryWriter {
    protected _indexes: Map<any, number>;
    
    protected   _atomCount: number;
    protected _objectCount: number;
    
    protected _head: BinaryWriter;
    protected _flag: number;

    constructor(indexes: Map<any, number>) {
        super(indexes.size * 4);
        
        this._indexes = indexes;

        this._atomCount = 0;
        this._objectCount = 0;

        this._head = new BinaryWriter(indexes.size);
        this._flag = 0;
    }

    next<T>(_: T, isObject = false) {
        const pointer = isObject ? -1 : this._indexes.get(_);
        if (pointer >= 0)
            _ = pointer as unknown as T;

        const coder = (pointer >= 0 ?
            Coders.POINTER : coderOf(_)) as Coder<T>;

        this._flag |= this._atomCount % 2 != 0 ? 
            coder.id << 4 : coder.id;
        if (this._atomCount % 2 != 0) {
            this._head.pushUint8(this._flag);
            this._flag = 0;
        }

        this._atomCount++;
        if (isObject)
            this._objectCount++;

        return coder.encode(_, this);
    }

    finish<T>(root: T) {
        if (this._flag != 0)
            this._head.pushUint8(this._flag);

        const metaOut = new BinaryWriter(16);
        metaOut.pushVarint(this._atomCount);
        metaOut.pushVarint(this._objectCount);
        metaOut.pushVarint(this._indexes.get(root));
        
        const meta = metaOut.Uint8Array;
        const head = this._head.Uint8Array;
        const body = this.Uint8Array;

        const metaOffset = 0;
        const metaSize   = meta.byteLength;

        const headOffset = metaSize;
        const headSize   = head.byteLength;

        const bodyOffset = headOffset + headSize;
        const bodySize   = body.byteLength;

        const flatten = new ArrayBuffer(metaSize + headSize + bodySize);

        const metaFlat = new Uint8Array(flatten, metaOffset, metaSize);
        const headFlat = new Uint8Array(flatten, headOffset, headSize);
        const bodyFlat = new Uint8Array(flatten, bodyOffset, bodySize);

        metaFlat.set(meta);
        headFlat.set(head);
        bodyFlat.set(body);

        return flatten;
    }
}

@serializable('@bin.Token', {
    predecode: (_) => Token.from(_.readUTF8String()),
    decode: (_, $) => { _.readUTF8String(); return $; },
    encode: ($, _) => _.pushUTF8String($.key),
    noindex: true,
} as CustomCoder<Token>)
export class Token {
    private key: string;

    constructor(key: string) {
        this.key = key;
        if (Token.instances.has(key))
            throw new Error(`Token "${key}" already defined!`);
        Token.instances.set(key, this);
    }

    static instances = new Map<string, Token>();

    static from(key: string) {
        const token = Token.instances.get(key);
        if (token)
            return token;
        return new Token(key);
    }
}

declare global {
    interface ArrayBufferConstructor {
        transfer(source: ArrayBuffer, length: number): ArrayBuffer;
    }
}

if (!ArrayBuffer.transfer) {
    ArrayBuffer.transfer = function(source, length) {
        if (!(source instanceof ArrayBuffer))
            throw new TypeError('Source must be an instance of ArrayBuffer');
        if (length <= source.byteLength)
            return source.slice(0, length);
        var sourceView = new Uint8Array(source),
            destView = new Uint8Array(new ArrayBuffer(length));
        destView.set(sourceView);
        return destView.buffer;
    };
}

declare global {
    interface Array<T> {
        last: T | undefined;
    }
}

if (!Object.getOwnPropertyDescriptor(Array.prototype, 'last')) {
    Object.defineProperty(Array.prototype, 'last', {
        get() { return this[this.length-1] }
    });
}

declare global {
    interface String {
        codePoints(): Iterable<number>;
        codePointsCount: number;
    }
    interface StringConstructor {
        fromCodePoints(codepoints: Iterable<number>): string;
        codePointSize(codepoint: number): number;
    }
    interface ObjectConstructor {
        getPropertyDescriptor(obj: any, p: string | number | symbol): PropertyDescriptor;
    }
}

if (!Object.getOwnPropertyDescriptor(Object, 'getPropertyDescriptor')) {
    Object.getPropertyDescriptor = function(obj: any, p: string | number | symbol) {
        let _: Object = this;
        while (_) {
            const descriptor = Object.getOwnPropertyDescriptor(_, p);
            if (descriptor)
                return descriptor;
            _ = Object.getPrototypeOf(_);
        }
        return undefined;
    }
}

if (!Object.getOwnPropertyDescriptor(String.prototype, 'codePoints')) {
    String.prototype.codePoints = function *codePoints() {
        for (var i = 0; i < this.length; i++)  {
            var u = this.charCodeAt(i);
            if (u >= 0xD800 && u <= 0xDFFF) {
                var u1 = this.charCodeAt(++i);
                u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
            }
            yield u;
        }
    }
}

if (!Object.getOwnPropertyDescriptor(String.prototype, 'codePointsCount')) {
    function codePointsCount() {
        var count = 0;
        for (var i = 0; i < this.length; i++)  {
            var u = this.charCodeAt(i);
            if (u >= 0xD800 && u <= 0xDFFF) {
                var u1 = this.charCodeAt(++i);
                u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
            }
            count++;
        }
        return count;
    }
    Object.defineProperty(String.prototype, 'codePointsCount', {get: codePointsCount});
}

if (!Object.getOwnPropertyDescriptor(String, 'fromCodePoints')) {
    String.fromCodePoints = function fromCodePoints(codepoints: Iterable<number>) {
        let text = '';
        for (let codepoint of codepoints)
            text += String.fromCodePoint(codepoint == 32 ? 160 : codepoint);
        return text;
    }
}


if (!Object.getOwnPropertyDescriptor(String, 'codePointSize')) {
    String.codePointSize = function codePointSize(codepoint: number) {
        return codepoint >= 0x10000 ? 2 : 1;
    }
}
