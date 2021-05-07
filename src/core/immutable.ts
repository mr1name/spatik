import * as bin from './binarizer';
import { randomInt } from './math';

@bin.serializable('immutable.ListNode')
class ListNode<T> {
    @bin.property(0) readonly data: T;
    @bin.property(1) readonly next?: ListNode<T>

    constructor(data: T, next?: ListNode<T>) {
        this.data = data;
        this.next = next;
    }
}

@bin.serializable('immutable.List')
export class List<T> {
    @bin.property(0) private readonly next: ListNode<T> | undefined;
    @bin.property(1) readonly length: number;

    private constructor(next: ListNode<T> | undefined, length: number) {
        this.next = next;
        this.length = length;
    }

    prepend(element: T): List<T> {
        const next = new ListNode(element, this.next);
        return new List(next, this.length + 1);
    }

    get first() { return this.next?.data; }

    static readonly empty = new List<any>(undefined, 0);

    *[Symbol.iterator]() {
        for (var next = this.next; next; next = next.next) 
            yield next.data;
    }
}

type VectorNode<T> = T[] | VectorNode<T>[];

@bin.serializable('immutable.Vector')
export class Vector<T> {
    @bin.property(0) private readonly root: VectorNode<T>;
    @bin.property(1) private readonly shift: number;
    @bin.property(2) readonly length: number;

    protected constructor(root: VectorNode<T>, shift: number, length: number) {
        this.root = root;
        this.shift = shift;
        this.length = length;
    }
    
    get(index: number): T {
        if (!(index >= 0 && index < this.length))
            return undefined;
        let shift = this.shift;
        let node = this.root;
        while (shift) {
            node = node[(index >> shift) & Vector.nodeBitmask] as VectorNode<T>;
            shift -= Vector.nodeBits;
        }
        return node[index & Vector.nodeBitmask] as T;
    }

    set(index: number, value: T): Vector<T> {
        if (index > this.length) {
            let vector: Vector<T> = this;
            for (var i = this.length; i < index; i++) 
                vector = vector.set(i, undefined);
            return vector.set(index, value);
        }

        if (index < this.length || this.length < (Vector.nodeSize << this.shift)) {
            const root = this.root.slice();
            let node = root;
            let shift = this.shift;
            while (shift > 0) {
                const nindex = (index >> shift) & Vector.nodeBitmask;
                if (node[nindex])
                    node[nindex] = (node[nindex] as VectorNode<T>).slice();
                else
                    node[nindex] = [];
                node = node[nindex] as VectorNode<T>;
                shift -= Vector.nodeBits;
            }
            node[index & Vector.nodeBitmask] = value;
            let length = index < this.length ? 
                this.length : index + 1;
            return new Vector(root, this.shift, length);
        }

        let node: VectorNode<T> = [];

        const root = [this.root.slice(), node];
        const shift = this.shift + Vector.nodeBits;
        const length = this.length + 1;

        for (var i = 2; i < (shift / Vector.nodeBits + 1); i++) {
            (node as VectorNode<T>[]).push([] as T[]);
            node = node[node.length-1] as VectorNode<T>;
        }
        (node as T[])[0] = value;
        return new Vector(root, shift, length);
    }

    pop(): Vector<T> {
        if (this.length < 2)
            return Vector.empty;
        if ((this.length & Vector.nodeBitmask) !== 1) {
            const vector = this.set(this.length-1, undefined);
            return new Vector(vector.root, vector.shift, vector.length-1);
        }
        if (this.length - 1 === Vector.nodeSize << (this.shift - Vector.nodeBits)) {
            const root = this.root[0] as VectorNode<T>;
            const shift = this.shift - Vector.nodeBits;
            return new Vector(root, shift, this.length-1);
        }
        const root = this.root.slice();
        const removedIndex = this.length-1;
        let node = root;
        let shift = this.shift;
        while (shift > Vector.nodeBits) {
            const localIndex = (removedIndex >> shift) & Vector.nodeBitmask;
            node = node[localIndex] = (node[localIndex] as VectorNode<T>[]).slice();
            shift -= Vector.nodeBits;
        }
        node[(removedIndex >> shift) & Vector.nodeBitmask] = undefined;
        return new Vector(root, shift, this.length-1);
    }

    append(element: T): Vector<T> {
        return this.set(this.length, element);
    }

    filter(predicate: (element: T) => boolean): Vector<T> {
        let _: Vector<T> = Vector.empty;
        for (let element of this)
            if (predicate(element)) _ = _.append(element);
        return _;
    }

    find(predicate: (element: T) => boolean): T {
        for (let element of this)
            if (predicate(element)) return element;
        return undefined;
    }

    static readonly empty = new Vector<any>([], 0, 0);

    private static readonly nodeBits = 5;
    private static readonly nodeSize = (1 << Vector.nodeBits);
    private static readonly nodeBitmask = Vector.nodeSize - 1;   

    get last() { return this.get(this.length - 1); }

    *[Symbol.iterator]() {
        const stack: [VectorNode<T>[], number][] = [];
        let node = this.root;
        var i = -1;
        while (i < this.length - 1) {
            if (i > 0 && (i & Vector.nodeBitmask) === Vector.nodeSize - 1) {
                let step = stack.pop();
                while (step[1] === Vector.nodeSize - 1) 
                    step = stack.pop();
                step[1]++;
                stack.push(step);
                node = step[0][step[1]];
            }
        
            for (let shift = stack.length * Vector.nodeBits; shift < this.shift; shift += Vector.nodeBits) {
                stack.push([node as VectorNode<T>[], 0]);
                node = node[0] as VectorNode<T>;
            }
            i++;
            yield node[i & Vector.nodeBitmask] as T;
        }
    }
}

@bin.serializable('immutable.ChronCursor')
export class ChronCursor<T> {
    @bin.property(0) readonly anchor: ChronEntry<T> | number;
    @bin.property(1) readonly offset: -1 | 1;

    constructor(anchor: ChronEntry<T> | number, offset: -1 | 1) {
        this.anchor = anchor;
        this.offset = offset;
    }

    isSame(_: ChronCursor<T>) {
        if (!_)
            return false;
        if (this === _)
            return true;
        if (_.offset != this.offset)
            return false;
        
        if (typeof this.anchor == 'number')
            return typeof _.anchor == 'number' ? 
                _.anchor == this.anchor : _.anchor.isSame(this.anchor);
        return this.anchor.isSame(_.anchor);
    }
}

@bin.serializable('immutable.ChronRange')
export class ChronRange<T> {
    @bin.property(0) readonly head: ChronCursor<T>;
    @bin.property(1) readonly tail: ChronCursor<T>;

    constructor(head: ChronCursor<T>, tail: ChronCursor<T>) {
        this.head = head;
        this.tail = tail;
    }

    static collapsed<T>(range: ChronRange<T>) { 
        return range.head.isSame(range.tail);
    }

    static tail<T>(range: ChronRange<T>) {
        return new ChronRange(range.tail, range.tail);
    }
}

@bin.serializable('immutable.ChronEntry')
export class ChronEntry<T> implements ChronRange<T> {
    @bin.property(0) readonly index: number;
    @bin.property(1) readonly key:  number;
    @bin.property(2) readonly atom:  T | typeof ChronEntry.deleted;
    @bin.property(3) readonly former?: number; 
    @bin.property(4) readonly latter?: number;

    constructor(index: number, 
                key:  number,
                atom:  T | typeof ChronEntry.deleted, 
                former?: number, 
                latter?: number) {
        this.index = index;
        this.key = key;
        this.atom = atom;
        this.former = former;
        this.latter = latter;
    };
    
    static readonly deleted = new bin.Token('immutable.Chron.deletion');

    get head(): ChronCursor<T> { return new ChronCursor(this, -1); }
    get tail(): ChronCursor<T> { return new ChronCursor(this,  1); }

    get data(): T { 
        if (this.deleted)   
            throw new Error('ChronEntry.data: entry is deleted!');
        return this.atom as T;
    }

    get deleted() { return this.atom == ChronEntry.deleted; }

    isSame(_: ChronEntry<T> | number) {
        if (this === _)
            return true;
        if (typeof _ == 'number')
            return this.key == _;
        return _.key  === this.key && 
               _.index === this.index;
    } 
}


@bin.serializable('immutable.Chron')
export class Chron<T> implements ChronRange<T> {
    @bin.property(0) private readonly log: Vector<ChronEntry<T>>;
    @bin.property(1) private readonly last: number;

    private constructor(log: Vector<ChronEntry<T>>, tail: number) {
        this.log = log;
        this.last = tail;
    }

    get randomKey() { return randomInt(1, 1 << 28); }

    insert(cursor: ChronCursor<T>, atom: T, key = this.randomKey): Chron<T> {
        let _ = this.prevTo(cursor);
        if (!_) 
            return this;
        const index = this.log.length;
        const log = this.log.
            set(_.index, new ChronEntry(_.index, _.key, _.atom, _.former, index)).
            set(index,   new ChronEntry(index, key, atom, _.index, _.latter));
        return new Chron(log, _.latter ? this.last : index);
    }   

    delete(element: ChronEntry<T>): Chron<T> {
        const _ = this.log.get(element.index);
        if (!_.isSame(element) || _.deleted)
            return this;
        const atom = ChronEntry.deleted;
        const log = this.log.
            set(_.index, new ChronEntry<T>(_.index, _.key, atom, _.former, _.latter));
        return new Chron(log, this.last);
    }

    get head() { return this.log.get(0).tail; }
    get tail() { return this.log.get(this.last).tail; }

    get recent(): ChronEntry<T> | undefined { return this.log.last; }
    
    nextTo(cursor: ChronCursor<T>) {
        const anchor = this.anchorOf(cursor)
        if (!anchor)
            return undefined;
        if (cursor?.offset < 0)
            return anchor;
        return this.log.get(anchor.latter);
    }

    prevTo(cursor: ChronCursor<T>) {
        let _ = this.anchorOf(cursor)
        if (!_)
            return undefined;
        if (cursor.offset > 0)
            return _;
        const index = _.index;
        _ = this.log.get(_.former);
        while (_ && _.latter != index)
            _ = this.log.get(_.latter);
        return _;
    }

    anchorOf(cursor: ChronCursor<T>): ChronEntry<T> {
        if (typeof cursor.anchor == 'number') 
            return this.find(entry => entry.key == cursor.anchor);
        const anchor = this.log.get(cursor.anchor.index);
        if (!anchor)
            return undefined;
        return anchor.isSame(cursor.anchor) ? anchor : undefined;
    }

    [Symbol.iterator]() { return this.range(this); }

    slice(range: ChronRange<T>): ChronSlice<T> {
        return new ChronSlice(this, range.head, range.tail);
    }

    find(test: (entry: ChronEntry<T>) => boolean, range?: ChronRange<T>): ChronEntry<T> {
        range = !range ? this : range  
        for (var _ of this.range(range))
            if (test(_)) return _;
        return undefined;
    }

    *range(range: ChronRange<T>) {
        const head = this.nextTo(range.head);
        const tail = this.nextTo(range.tail);
        for (let _ = head; _ && _ != tail; _ = this.log.get(_.latter)) 
            yield _;
    }

    *data(range?: ChronRange<T>) {
        for (let _ of this.range(range ? range : this))
            if (!_.deleted) yield _.data;
    }

    static readonly root = new ChronEntry<any>(0, 0, ChronEntry.deleted);
    static readonly empty = new Chron<any>(Vector.empty.append(Chron.root), 0);
}

@bin.serializable('immutable.ChronSlice')
export class ChronSlice<T> extends ChronRange<T> {
    @bin.property(0) private chron: Chron<T>;

    constructor(chron: Chron<T>, head: ChronCursor<T>, tail: ChronCursor<T>) {
        super(head, tail);
        this.chron = chron;    
    }

    get first() { return this.chron.nextTo(this.head); }

    [Symbol.iterator]() { return this.chron.range(this); }
    data() { return this.chron.data(this); }
}

@bin.serializable('immutable.ChronMarker')
export class ChronMarker<M, T> {
    @bin.property(0) readonly data: M;
    @bin.property(1) readonly range: ChronRange<T> | undefined;

    constructor(data: M, range?: ChronRange<T>) {
        this.data = data;
        this.range = range;
    } 
}

export interface ChronMarkerSet<M, T> {
    add(marker: M, cursor: ChronCursor<T>): void;
    delete(marker: M, cursor: ChronCursor<T>): void;
    covered?: (marker: M, range: ChronRange<T>) => void;
    filter?: (marker: M, range: ChronRange<T>) => boolean
}

@bin.serializable('immutable.ChronMarkup')
export class ChronMarkup<M, T> {
    @bin.property(0) private readonly markers: Vector<ChronMarker<M, T>>;

    private constructor(markers: Vector<ChronMarker<M, T>>) {
        this.markers = markers;
    }

    mark(data: M, range: ChronRange<T>): ChronMarkup<M, T> {
        let garbage = 0;
        for (let marker of this.markers)
            if (!marker.range) garbage++;

        if (garbage > 16) {
            let copy = ChronMarkup.empty;
            for (let marker of this.markers)
                if (marker.range) copy = copy.mark(marker.data, marker.range);
            return copy.mark(data, range);
        }

        let markers = this.markers;
        for (var i = 0; i < markers.length; i++) {
            const entry = markers.get(i);
            if (entry.data != data)  
                continue;
            markers = markers.set(i, new ChronMarker(data, range));
            return new ChronMarkup(markers);
        }
        markers = markers.append(new ChronMarker(data, range));
        return new ChronMarkup(markers);
    }

    rangeOf(data: M): ChronRange<T> | undefined {
        for (let _ of this.markers)
            if (_.data == data) return _.range;
        return undefined;
    } 

    unmark(data: M): ChronMarkup<M, T> { return this.mark(data, undefined); }

    *[Symbol.iterator]() {
        for (let marker of this.markers)
            if (marker.range) yield marker;
    }

    *entries(chron: Chron<T>, set: ChronMarkerSet<M, T>, range?: ChronRange<T>) {
        const heads = new Map<number, ChronMarker<M, T>[]>();
        const tails = new Map<number, ChronMarker<M, T>[]>();

        const push = (cursor: ChronCursor<T>, marker: ChronMarker<M, T>) => {
            const map = cursor.offset < 0 ? heads : tails;
            const key = chron.anchorOf(cursor)?.index || -1;
            map.has(key) ? map.get(key).push(marker) : map.set(key, [marker]);
        }

        for (let marker of this) {
            if (set.filter && !set.filter(marker.data, marker.range))
                continue;
            push(marker.range.head, marker);
            push(marker.range.tail, marker);
        }

        const markers = new Set<ChronMarker<M, T>>();
        const trigger = (_: ChronMarker<M, T>, silent = false) => {
            if (markers.has(_)) { 
                markers.delete(_); 
                if (!silent) set.delete(_.data, _.range.tail); 
            } else {
                markers.add(_);    
                if (!silent) set.add(_.data, _.range.head);    
            }
        }

        const suppressHead = range && range.head != chron.head;
        heads.get(-1)?.forEach(_ => trigger(_, suppressHead));
        tails.get(-1)?.reverse()?.forEach(_ => trigger(_, suppressHead));

        const supressRange = range ? new ChronRange(chron.head, range.head) : undefined;
        if (range) for (let entry of chron.range(supressRange)) {
            heads.get(entry.index)?.forEach(_ => trigger(_, true));
            tails.get(entry.index)?.reverse()?.forEach(_ => trigger(_, true));
        }

        const rangeMayBeCoveredBy = new Set(markers);
        const entries = range ? 
            chron.range(range) : chron[Symbol.iterator]();
        for (let entry of entries) {
            heads.get(entry.index)?.forEach(_ => trigger(_, false));
            yield entry;
            tails.get(entry.index)?.reverse()?.forEach(_ => trigger(_, false));
        }

        if (set.covered) for (let _ of rangeMayBeCoveredBy)
            if (markers.has(_)) set.covered(_.data, _.range);
    }   

    static readonly empty = new ChronMarkup<any, any>(Vector.empty);
}