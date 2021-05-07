import { Model, model, slot, waveMerge, AnyProxy, BoundRef, AnyWaveApp } from '../core/model';
import { initCroquetSession } from '../core/croquet';
import * as dom from '../core/dom';
import * as bin from '../core/binarizer';
import { Chron, ChronCursor, ChronRange, ChronMarkup, ChronMarkerSet, ChronSlice } from '../core/immutable';

export type TextMarkerParameters =  {[key: string]: string};

@bin.serializable('TextMarker')
export class TextMarker {
    @bin.property(0) readonly tag: string;
    @bin.property(1) readonly parameters?: TextMarkerParameters;

    constructor(tag: string, parameters?: TextMarkerParameters) { 
        this.tag = tag; 
        this.parameters = parameters;
    }
}

@model('Text')
export class Text extends Model {
    @slot() codepoints: Chron<number>;
    @slot() markup: ChronMarkup<TextMarker, number>;

    init() {
        this.codepoints = Chron.empty;
        this.markup = ChronMarkup.empty;
    }

    @waveMerge('typing', 8)
    insert(cursor: ChronCursor<number>, text: string, key?: number): ChronRange<number> {
        if (text.length < 1)
            return undefined;
        let head: ChronCursor<number>;
        let log = this.codepoints;
        let codePointsRemain = text.codePointsCount;
        for (let code of text.codePoints()) {
            codePointsRemain--;
            log = log.insert(cursor, code, !codePointsRemain ? key : undefined);
            cursor = log.recent.tail;
            if (!head) head = log.recent.head;
        }
        this.codepoints = log;
        return new ChronRange(head, cursor);
    }

    replace(range: ChronRange<number>, text: string, key?: number): ChronRange<number> {
        this.delete(range);
        return this.insert(range.tail, text, key);
    }

    delete(range: ChronRange<number>) {
        let log = this.codepoints;
        for (let entry of log.range(range))
            log = log.delete(entry);
        this.codepoints = log;
    }

    mark(range: ChronRange<number>, tag: string, parameters?: TextMarkerParameters) {
        this.unmark(range, tag);
        this.markup = this.markup.mark(new TextMarker(tag, parameters), range);
    }

    unmark(range: ChronRange<number>, tag: string) {
        const added = new Set<TextMarker>();
        const removed = new Set<TextMarker>();

        let markup = this.markup;
        const set: ChronMarkerSet<TextMarker, number> = {
            filter: _ => _.tag == tag,
            add: _ => added.add(_),
            delete: _ => {
                if (added.has(_)) {
                    markup = markup.unmark(_);
                    added.delete(_)
                } else removed.add(_);
            },
            covered: _ => {
                const head = new ChronRange(markup.rangeOf(_).head, range.head);
                const tail = new ChronRange(range.tail, markup.rangeOf(_).tail);
                markup = markup.mark(_, head);
                markup = markup.mark(new TextMarker(_.tag, _.parameters), tail);
            }
        };

        for (let _ of this.markup.entries(this.codepoints, set, range));

        for (let marker of added) {
            const _ = new ChronRange(range.tail, markup.rangeOf(marker).tail);
            markup = markup.mark(marker, _);
        }

        for (let marker of removed) {
            const _ = new ChronRange(markup.rangeOf(marker).head, range.head);
            markup = markup.mark(marker, _);
        }

        this.markup = markup;
    }
}

export type TextViewDecorator = 
    (part: TextPartView) => TextPartViewStyle | undefined;

export type TextPartViewStyle = {
    tag: string,
    text?: (text: string) => string,
    attributes?: dom.ElementAttributes,
}

export class TextPartView {
    node?: Node;

    readonly markers: TextMarker[];
    readonly slice: ChronSlice<number>;
    readonly text: string;
    
    constructor(slice: ChronSlice<number>, markers: TextMarker[]) {
        this.node = undefined;

        this.markers = markers;
        this.slice = slice;
        this.text = String.fromCodePoints(slice.data());
    }

    get key()   { return this.slice.first?.index }
    get empty() { return this.text.length < 1; }

    findCursor(offset: number, collapsed: boolean): ChronCursor<number> {
        if (offset >= this.text.length)
            return this.slice.tail;
        if (offset < 1) 
            return this.slice.head;
       
        if (collapsed)
            offset -= 1;
            
        let index = 0;
        for (let _ of this.slice) 
            if (index >= offset && !_.deleted) 
                return collapsed ? _.tail : _.head;
            else if (!_.deleted) index += String.codePointSize(_.data);
    }

    render(_: dom.ElementBuilder, decorate: TextViewDecorator) {
        const style = decorate(this);
        if (!style) 
            return;
        _.open(style.tag, this.key, style.attributes);
            this.node = _.text(style.text ? style.text(this.text) : this.text);
        _.close(style.tag);
    }
}

@dom.customElement('text-view')
export class TextView extends HTMLElement {
    private parts: TextPartView[];
    private selection: ChronRange<number>; 

    private insertionCursor: ChronCursor<number>;
    private insertionQueue: Promise<ChronRange<number>>;

    private dirty: boolean;
    private renderNeeded: boolean;

    constructor(public model: AnyProxy<Text>,
                public decorator?: TextViewDecorator) {
        super();
        this.selection = undefined;
        this.dirty = false;
        this.renderNeeded = false;
        this.insertionCursor = undefined;
        this.insertionQueue = undefined;

        this.contentEditable = 'true';

        this.addEventListener('keydown', (event) => {
            if (event.ctrlKey || event.metaKey) 
                return false;
            if (event.key.startsWith('Arrow'))
                return false;
            if (event.key == 'Shift')
                return false;
            if (event.key == 'Alt')
                return false;
            event.preventDefault();
            if (event.key == 'Tab') {
                this.mark('bold');
            } else if (event.key == 'Backspace') {
                this.delete();
            } else {
                // this.selection = 
                this.insertString(event.key);
            }
        });

        this.addEventListener('paste', (event) => {
            event.preventDefault();
            const text = event.clipboardData?.getData('text');
            if (text) this.insertString(text);
        })

        window.document.addEventListener('selectionchange', ()  => {
            if (this.dirty)
                return;

            if (this.selectionCache) {
                const selection = document.getSelection();
                const _0 = this.selectionCache;
                if (selection.rangeCount > 0) {
                    const _1 = selection.getRangeAt(0);
                    if (_1.startContainer == _0.startContainer &&
                        _1.startOffset == _0.startOffset &&
                        _1.endContainer == _0.endContainer &&
                        _1.endOffset == _0.endOffset) 
                            return;
                }
            }

            this.insertionCursor = undefined;
            this.insertionQueue = undefined;
            this.selection = this.findSelection();
        });
    }

    private insertionTasks: string[] = [];
    private insertingString = false;

    private _insertString(text: string) {
        const range = this.insertionCursor ?
            new ChronRange(this.insertionCursor, this.insertionCursor) : 
            this.selection;
        if (!range)
            return;
        const key = this.model.codepoints.randomKey;
        this.insertionCursor = new ChronCursor(key, 1);
        if (!ChronRange.collapsed(range)) {
            this.insertionQueue = this.model.replace(range, text, key) as 
                Promise<ChronRange<number>>;
            this.selection = ChronRange.tail(this.selection);
        } else {
            this.insertionQueue = this.model.insert(range.tail, text, key) as 
                Promise<ChronRange<number>>;
        }
    }

    private mark(tag: string, parameters?: TextMarkerParameters) {
        const range = this.selection;
        if (ChronRange.collapsed(range))
            return;
        this.model.mark(range, tag, parameters);
    }

    private insertString(text: string) {
        this.insertionTasks.unshift(text);
        if (this.insertingString)
            return;
        this.insertingString = true;
        while (this.insertionTasks.length > 0)
            this._insertString(this.insertionTasks.pop());
        this.insertingString = false;
    }

    private delete() {
        const range = this.selection;
        if (ChronRange.collapsed(range)) {
            const codepoints = this.model.codepoints;
            let _ = codepoints.prevTo(range.tail);
            while (_ && _.deleted)
                _ = codepoints.prevTo(_.head);
            if (_)
                this.model.delete(_);
        } else {
            this.selection = ChronRange.tail(range);
            this.model.delete(range);
        }
    }

    private textOffsetOf(cursor: ChronCursor<number>) {
        const codepoints = this.model.codepoints;
        const anchor = codepoints.anchorOf(cursor);
        if (!anchor)
            return 0;

        if (codepoints.head.isSame(cursor))
            return 0;

        let index = 0;
        for (let _ of codepoints) {
            const found = _.isSame(anchor);
            if (found && cursor.offset < 0)
                break;
            if (!_.deleted) 
                index += String.codePointSize(_.data);
            if (found) break;
        }
        return index;
    }

    private findOffset(cursor: ChronCursor<number>) {
        if (!(this.parts.length > 0))
            return undefined;

        const targetOffset = this.textOffsetOf(cursor);

        let offset = 0;
        for (let part of this.parts) {
            let index = 0;
            if (part.node && offset >= targetOffset)
                return {part, index};
            for (let _ of part.slice) {
                if (_.deleted) 
                    continue;
                const size = String.codePointSize(_.data);
                offset += size; index += size;
                if (part.node && offset >= targetOffset)
                    return {part, index};
            }
        }

        return undefined;
    }
    
    private selectionCache: {
        startContainer: Node, 
        startOffset: number, 
        endOffset: number, 
        endContainer: Node,
    } = undefined;

    private forceSelection(range: ChronRange<number>) {
        const head = this.findOffset(range.head);
        const tail = this.findOffset(range.tail);

        const selection = document.getSelection();
        if (selection.rangeCount < 1)
            return
        
        let _ = selection.getRangeAt(0);
        _ = _.cloneRange(); // when editor located in shadow dom
                            // calling setStart & setEnd on existing range
                            // does nothing.
        if (head) _.setStart(head.part.node, head.index);
        if (tail) _.setEnd(tail.part.node, tail.index);
        selection.removeAllRanges();
        selection.addRange(_);

        this.selectionCache = {
            startContainer: _.startContainer,
            startOffset: _.startOffset,
            endContainer: _.endContainer,
            endOffset: _.endOffset,
        }
    }

    private findSelection(): ChronRange<number> {
        const selection = document.getSelection();
        if (selection.rangeCount < 1 || !selection.containsNode(this, true))
            return undefined;

        const findCursor = (node: Node, offset: number, collapsed: boolean) =>  
            this.parts?.find(p => p.node == node)?.findCursor(offset, collapsed);

        const _ = selection.getRangeAt(0);

        let head = findCursor(_.startContainer, _.startOffset, _.collapsed);
        if (!head) head = this.model.codepoints.head;

        let tail = findCursor(_.endContainer, _.endOffset, _.collapsed);
        if (!tail) tail = this.model.codepoints.tail;
        
        return {head, tail};
    }

    async render() {
        if (this.dirty) {
            this.renderNeeded = true;
            return;
        }
        this.dirty = true;

        if (this.insertionQueue) {
            const range = await this.insertionQueue;
            this.selection = ChronRange.tail(range);
        }

        const codepoints = this.model.codepoints;
        const parts: TextPartView[] = [];

        const head = () => parts.last ?
            parts.last.slice.tail : codepoints.head;
        const slice = (tail: ChronCursor<number>) =>
            codepoints.slice(new ChronRange(head(), tail));

        let markup: TextMarker[] = [];
        const flush = (tail: ChronCursor<number>, markers: TextMarker[]) => {
            parts.push(new TextPartView(slice(tail), markup));
            markup = markers;
        }

        const markers: ChronMarkerSet<TextMarker, number> = {
            add:    (_, cursor) => flush(cursor, markup.concat(_)),
            delete: (_, cursor) => flush(cursor, markup.filter(k => k != _)),
        }

        for (let _ of this.model.markup.entries(codepoints, markers));
        flush(codepoints.tail, []);

        const selection = this.selection;
        const decorate = this.decorator || DumbTextViewDecorator;
        dom.patch(this, _ => {
            parts.forEach(p => p.render(_, decorate))
            this.parts = parts;
            if (selection)
                this.forceSelection(selection);
            this.dirty = false;
            if (this.renderNeeded) {
                this.renderNeeded = false;
                this.render();
            }
        });

    }
}

export const DumbTextViewDecorator: TextViewDecorator = 
    (part) => part.empty ? undefined : {
        tag: 'span',
        attributes: {class: part.markers.map(m => m.tag).join(' ')}
    };

@model('Rectangle')
export class Rectangle extends Model {
    @slot() x: number;
    @slot() y: number;
    @slot() w: number;
    @slot() h: number;
 
    init(x: number, y: number, w: number, h: number) {
        this.moveTo(x, y);
        this.resizeTo(w, h);
    }

    @waveMerge('this:move')
    moveTo(x: number, y: number) {
        this.x = x;
        this.y = y;
    }

    @waveMerge('this:resize')
    resizeTo(w: number, h: number) {
        this.w = w;
        this.h = h;
    }
}

@dom.customElement('window-view')
export class WindowView extends dom.ReactiveTemplate<Rectangle> {
    constructor(app: AnyWaveApp, ref: BoundRef<Rectangle>, text: BoundRef<Text>) {
        super(app, ref);

        this.textView = new TextView(app.bind(text));
        app.watch(text, () => this.textView.render());

        document.addEventListener('mousemove', (event: MouseEvent) => {
            if (!this.dragging)
                return;
            this.model.moveTo(
                event.clientX + this.mouseOrigin.x,
                event.clientY + this.mouseOrigin.y,
            );
        });

        document.addEventListener('mouseup', () => this.dragging = false);
    }

    startMove(event: MouseEvent) {
        const self = this.getBoundingClientRect();
        this.dragging = true;
        this.mouseOrigin = {
            x: self.x - event.clientX,
            y: self.y - event.clientY,
        };
    }

    @dom.property()
    textView: TextView;

    @dom.property()
    dragging = false;

    @dom.property()
    mouseOrigin = {
        x: 0,
        y: 0,
    }

    static styles = `
        window-view {
            display: block;
            position: absolute;
            display: flex;
            flex-direction: column;
            border: 1px solid rgba(100, 100, 100, 1.0);
            border-radius: 4px;
        }
        window-view > .header {
            flex: 0 0 24px;
            background: rgba(232, 234, 230);
            border-radius: 4px 4px 0px 0px;
            border-bottom: 1px solid rgba(200, 200, 200, 1.0);
        }
        window-view > .body {
            position: relative;
            flex: 1 1 auto;
            background: white;
            border-radius: 0px 0px 4px 4px;
        }
        window-view > .body > text-view {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            color: black;
            outline: none !important;
            padding: 16px;
        }
        window-view > .body > text-view > .bold {
            font-weight: bold;
        }`;

    render() {
        this.style.top    = `${this.model.y}px`;
        this.style.left   = `${this.model.x}px`;
        this.style.width  = `${this.model.w}px`;
        this.style.height = `${this.model.h}px`;
        return dom.html`
            <div class="header" @mousedown="${this.startMove.bind(this)}"></div>
            <div class="body">${this.textView}</div>`;
    }
}


export async function runEditor() {
    const session = await initCroquetSession({
        appId: 'com.spatik.playground',
        name: 'test80',
        password: '123',
    });

    const app = session.view;
    
    // uncomment to create new editor instance
    // ----------------------------
    // const text = await app.create(Text);
    // const rect = await app.create(Rectangle, 100, 100, 480, 480);
    // console.log(text, rect);

    const text = await app.bind<Text>('@1');
    const rect = await app.bind<Rectangle>('@2');

    await text.insert(text.codepoints.tail, 'Hello, ');
    const range = await text.insert(text.codepoints.tail, 'world');
    await text.insert(text.codepoints.tail, '!');
    await text.mark(range, 'bold');

    const textView = new TextView(text);
    document.body.appendChild(textView);
    app.watch(text, () => textView.render());

    const view = new WindowView(app, rect, text);
    document.body.appendChild(view);

    document.addEventListener('keydown', event => {
        if (event.key == 'z' && event.ctrlKey) {
            event.preventDefault();
            app.undo();
        }
        if (event.key == 'y' && event.ctrlKey) {
            event.preventDefault();
            app.redo();
        }
    });
}
