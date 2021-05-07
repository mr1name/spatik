import * as lit from 'lit-html';
import { AnyWaveApp, AnyProxy, BoundRef, Model, Subscription } from './model';
import * as dom from 'incremental-dom';

export const property = () => (prototype: any, key: string) => {
    const mangledKey = `_${key}`;
    const get = function() {
        return this[mangledKey];
    }
    const set = function(value: any) {
        this[mangledKey] = value;
        (this as TemplateElement).scheduleUpdate();
    }
    Object.defineProperty(prototype, key, {get, set});
};

export const customElement = (name: string) => (target: any) => {
    CustomElement.define(name, target);
}

export const html = lit.html;

export class CustomElement extends HTMLElement {
    constructor() {
        super();
        CustomElement._requestStylesheet();
    }

    private static _styles: string = ``;
    private static _styleElement: HTMLStyleElement = undefined;

    private static _appendStyles(name: string, css: string) {
        this._styles += `/* ${name} styles */ ${css}\n`;
        if (this._styleElement)
            this._styleElement.textContent = this._styles;
    }

    private static _requestStylesheet() {
        if (this._styleElement)
            return;
        this._styleElement = document.createElement('style');
        this._styleElement.textContent = this._styles;
        document.head.appendChild(this._styleElement);
    }

    static define(name: string, constructor: CustomElementConstructor) {
        customElements.define(name, constructor);
        if (Object.getOwnPropertyDescriptor(constructor, 'styles')) {
            const styles = (constructor as any).styles as string;
            this._appendStyles(name, styles);
        }
    }
}

export class TemplateElement extends CustomElement {
    private _updateScheduled: boolean;

    constructor() {
        super();
        this._updateScheduled = true;
        this._forceUpdate();
    }

    private _forceUpdate() {
        if (!this.isConnected)
            return;
        let template = this.render();
        if (template != this) {
            if (!template) 
                template = html``;
            lit.render(template, this);
        }
        this._updateScheduled = false;
    }

    scheduleUpdate() {
        if (this._updateScheduled)
            return;
        this._updateScheduled = true;
        requestAnimationFrame(this._forceUpdate.bind(this));
    }

    connectedCallback() {
        if (this._updateScheduled)
            this._forceUpdate();
    }

    disconnectedCallback() { return; }

    render(): lit.TemplateResult | void | this {
        return this;
    }
}

export class ReactiveTemplate<T extends Model> extends TemplateElement {
    @property() protected app: AnyWaveApp;
    @property() protected model: AnyProxy<T>;

    @property() 
    private _ticks: number;
    private _subscription?: Subscription;

    constructor(app: AnyWaveApp, ref: BoundRef<T>) {
        super();
        this.app = app;
        this.model = app.bind(ref);
        this._ticks = 0;
        this.init();
    }

    init() { /* placeholder ... */ }

    connectedCallback() {
        super.connectedCallback();
        if (this._subscription)
            this._subscription.unsubscribe();
        this._subscription = this.app.watch(this.model, () => this._ticks++);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._subscription)
            this._subscription.unsubscribe();
    }
}

export interface ElementBuilder {
    open(tag: string, key: string | number, attributs?: ElementAttributes): HTMLElement;
    text(value: string | number): Text;
    close(tag: string): Element;
}

const _ElementBuilder: ElementBuilder = {
    open(tag: string, key: string | number, attributes?: ElementAttributes) {
        const args = [];
        if (attributes) for (let key in attributes)
            if (attributes[key]) args.push(key, attributes[key]);
        return dom.elementOpen(tag, key, null, ...args);
    },
    text(value: string | number)  { return dom.text(value); },
    close(tag: string) { return dom.elementClose(tag); }
}

export type ElementAttributes = {[k: string]: string | number};
export type TextNode = Text;

export function patch(element: Element, template: (builder: ElementBuilder) => void) {
    dom.patch(element, () => template(_ElementBuilder));
}
