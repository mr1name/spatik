import * as bin from './binarizer';

export function randomInt(min: number = 0, max: number = Number.MAX_SAFE_INTEGER) {
    min = Math.ceil(min);
    max = Math.floor(max);
    const int = Math.floor(Math.random() * (max - min) + min);
    return int;
}

@bin.serializable('math.Point')
export class Point {
    @bin.property(0) readonly x: number;
    @bin.property(1) readonly y: number;

    constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }

    moveTo(x: number, y: number) { return new Point(x, y); }
}

@bin.serializable('math.Rectangle')
export class Rectangle {
    @bin.property(0) readonly x: number;
    @bin.property(1) readonly y: number;
    @bin.property(2) readonly w: number;
    @bin.property(3) readonly h: number;

    constructor(x: number, y: number, w: number, h: number) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
    }

    moveTo  (x: number, y: number) { return new Rectangle(x, y, this.w, this.h); }
    resizeTo(w: number, h: number) { return new Rectangle(this.x, this.y, w, h); }
}