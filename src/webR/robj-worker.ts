/**
 * Module for working with R objects on the worker thead.
 * @module RWorker
 */
import { Module } from './emscripten';
import { Complex, isComplex, NamedEntries, NamedObject, WebRDataRaw, WebRDataScalar } from './robj';
import { WebRData, WebRDataAtomic, RPtr, RType, RTypeMap, RTypeNumber, RCtor } from './robj';
import { isWebRDataJs, WebRDataJs, WebRDataJsAtomic, WebRDataJsNode } from './robj';
import { WebRDataJsNull, WebRDataJsString, WebRDataJsSymbol } from './robj';
import { isSimpleObject } from './utils';
import { envPoke, parseEvalBare, protect, protectInc, unprotect } from './utils-r';
import { protectWithIndex, reprotect, unprotectIndex, safeEval } from './utils-r';
import { EvalROptions, ShelterID, isShelterID } from './webr-chan';

export type RHandle = RObject | RPtr;

export function handlePtr(x: RHandle): RPtr {
  if (isRObject(x)) {
    return x.ptr;
  } else {
    return x;
  }
}

// Throw if an R object does not match a certain R type
function assertRType(obj: RObjectBase, type: RType) {
  if (Module._TYPEOF(obj.ptr) !== RTypeMap[type]) {
    throw new Error(`Unexpected object type "${obj.type()}" when expecting type "${type}"`);
  }
}

// TODO: Shelter should be a dictionary not an array
export const shelters = new Map<ShelterID, RPtr[]>();

// Use this for implicit protection of objects sent to the main
// thread. Currently uses the precious list but could use a different
// mechanism in the future. Unprotection is explicit through
// `Shelter.destroy()`.
export function keep(shelter: ShelterID, x: RHandle) {
  const ptr = handlePtr(x);
  Module._R_PreserveObject(ptr);

  // TODO: Remove when shelter transition is complete
  if (shelter === undefined) {
    return;
  }

  if (isShelterID(shelter)) {
    shelters.get(shelter)!.push(ptr);
    return;
  }

  throw new Error('Unexpected shelter type ' + typeof shelter);
}

// Frees objects preserved with `keep()`. This method is called by
// users in the main thread to release objects that were automatically
// protected before being sent away.
export function destroy(shelter: ShelterID, x: RHandle) {
  const ptr = handlePtr(x);
  Module._R_ReleaseObject(ptr);

  const objs: RPtr[] = shelters.get(shelter)!;
  const loc = objs.indexOf(ptr);

  if (loc < 0) {
    throw new Error("Can't find object in shelter.");
  }

  objs.splice(loc, 1);
}

export function purge(shelter: ShelterID) {
  const ptrs: RPtr[] = shelters.get(shelter)!;

  for (const ptr of ptrs) {
    try {
      Module._R_ReleaseObject(ptr);
    } catch (e) {
      console.error(e);
    }
  }

  shelters.set(shelter, []);
}

export interface ToJsOptions {
  depth: number;
}

export type Nullable<T> = T | RNull;

function newObjectFromData(obj: WebRData): RObject {
  // Conversion of WebRDataJs type JS objects
  if (isWebRDataJs(obj)) {
    return new (getRWorkerClass(obj.type))(obj);
  }

  // Map JS's 'undefined' type to R's NULL object
  if (typeof obj == 'undefined') {
    return new RNull();
  }

  // Conversion of explicit R NULL value
  if (obj && typeof obj === 'object' && 'type' in obj && obj.type === 'null') {
    return new RNull();
  }

  // Direct conversion of scalar JS values
  if (obj === null) {
    return new RLogical({ type: 'logical', names: null, values: [null] });
  }
  if (typeof obj === 'boolean') {
    return new RLogical(obj);
  }
  if (typeof obj === 'number') {
    return new RDouble(obj);
  }
  if (typeof obj === 'string') {
    return new RCharacter(obj);
  }
  if (isComplex(obj)) {
    return new RComplex(obj);
  }

  // Conversion of composite JS objects
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return new RRaw(obj);
  }
  if (Array.isArray(obj)) {
    return newObjectFromArray(obj);
  }
  // Any other JS object shape is reserved for creating an R `data.frame`
  if (typeof obj === 'object') {
    return RDataFrame.fromObject(obj);
  }

  throw new Error('R object construction for this JS object is not yet supported.');
}

function newObjectFromArray(arr: WebRData[]): RObject {
  const prot = { n: 0 };

  // Is this a D3 formatted data frame?
  const hasObjects = arr.every((v) => v && typeof v === 'object' && !isRObject(v) && !isComplex(v));
  if (hasObjects) {
    const _arr = arr as { [key: string]: WebRData }[];
    const isConsistent = _arr.every((a) => {
      return Object.keys(a).filter((k) => !Object.keys(_arr[0]).includes(k)).length === 0 &&
        Object.keys(_arr[0]).filter((k) => !Object.keys(a).includes(k)).length === 0;
    });
    const isAtomic = _arr.every((a) => Object.values(a).every((v) => {
      return isAtomicType(v) || isRVectorAtomic(v);
    }));
    if (isConsistent && isAtomic) {
      return RDataFrame.fromD3(_arr);
    }
  }

  // Not D3 formatted - Can we shortcut and convert directly?
  if (arr.every((v) => typeof v === 'boolean' || v === null)) {
    return new RLogical(arr as (boolean | null)[]);
  }
  if (arr.every((v) => typeof v === 'number' || v === null)) {
    return new RDouble(arr as (number | null)[]);
  }
  if (arr.every((v) => typeof v === 'string' || v === null)) {
    return new RCharacter(arr as (string | null)[]);
  }

  // Not D3 & mixed types: use R's built in object coercion with c() so as to
  // match R's built in coercion rules
  try {
    const call = new RCall([new RSymbol('c'), ...arr]);
    protectInc(call, prot);
    return call.eval();
  } finally {
    unprotect(prot.n);
  }
}

export class RObjectBase {
  ptr: RPtr;
  constructor(ptr: RPtr) {
    this.ptr = ptr;
  }

  type(): RType {
    const typeNumber = Module._TYPEOF(this.ptr) as RTypeNumber;
    const type = Object.keys(RTypeMap).find(
      (typeName) => RTypeMap[typeName as RType] === typeNumber
    );
    return type as RType;
  }
}

export class RObject extends RObjectBase {
  constructor(data: WebRData) {
    if (!(data instanceof RObjectBase)) {
      return newObjectFromData(data);
    }

    super(data.ptr);
  }

  static wrap<T extends typeof RObject>(this: T, ptr: RPtr): InstanceType<T> {
    const typeNumber = Module._TYPEOF(ptr) as RTypeNumber;
    const type = Object.keys(RTypeMap)[Object.values(RTypeMap).indexOf(typeNumber)];
    return new (getRWorkerClass(type as RType))(new RObjectBase(ptr)) as InstanceType<T>;
  }

  get [Symbol.toStringTag](): string {
    return `RObject:${this.type()}`;
  }

  /** @internal */
  static getPersistentObject(prop: keyof typeof objs): unknown {
    return objs[prop];
  }

  /** @internal */
  getPropertyValue(prop: keyof this): unknown {
    return this[prop];
  }

  inspect(): void {
    parseEvalBare('.Internal(inspect(x))', { x: this });
  }

  isNull(): this is RNull {
    return Module._TYPEOF(this.ptr) === RTypeMap.null;
  }

  isNa(): boolean {
    try {
      const result = parseEvalBare('is.na(x)', { x: this }) as RLogical;
      protect(result);
      return result.toBoolean();
    } finally {
      unprotect(1);
    }
  }

  isUnbound(): boolean {
    return this.ptr === objs.unboundValue.ptr;
  }

  attrs(): Nullable<RPairlist> {
    return RPairlist.wrap(Module._ATTRIB(this.ptr));
  }

  class(): RCharacter {
    const prot = { n: 0 };
    const classCall = new RCall([new RSymbol('class'), this]);
    protectInc(classCall, prot);
    try {
      return classCall.eval() as RCharacter;
    } finally {
      unprotect(prot.n);
    }
  }

  setNames(values: (string | null)[] | null): this {
    let namesObj: RObject;

    if (values === null) {
      namesObj = objs.null;
    } else if (Array.isArray(values) && values.every((v) => typeof v === 'string' || v === null)) {
      namesObj = new RCharacter(values);
    } else {
      throw new Error('Argument to setNames must be null or an Array of strings or null');
    }

    // `setAttrib()` protects its inputs
    Module._Rf_setAttrib(this.ptr, objs.namesSymbol.ptr, namesObj.ptr);
    return this;
  }

  names(): (string | null)[] | null {
    const names = RCharacter.wrap(Module._Rf_getAttrib(this.ptr, objs.namesSymbol.ptr));
    if (names.isNull()) {
      return null;
    } else {
      return names.toArray();
    }
  }

  includes(name: string) {
    const names = this.names();
    return names && names.includes(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toJs(options: ToJsOptions = { depth: 0 }, depth = 1): WebRDataJs {
    throw new Error('This R object cannot be converted to JS');
  }

  subset(prop: number | string): RObject {
    return this.#slice(prop, objs.bracketSymbol.ptr);
  }

  get(prop: number | string): RObject {
    return this.#slice(prop, objs.bracket2Symbol.ptr);
  }

  getDollar(prop: string): RObject {
    return this.#slice(prop, objs.dollarSymbol.ptr);
  }

  #slice(prop: number | string, op: RPtr): RObject {
    const prot = { n: 0 };

    try {
      const idx = new RObject(prop);
      protectInc(idx, prot);

      const call = Module._Rf_lang3(op, this.ptr, idx.ptr);
      protectInc(call, prot);

      return RObject.wrap(safeEval(call, objs.baseEnv));
    } finally {
      unprotect(prot.n);
    }
  }

  pluck(...path: (string | number)[]): RObject | undefined {
    const index = protectWithIndex(objs.null);

    try {
      const getter = (obj: RObject, prop: string | number): RObject => {
        const out = obj.get(prop);
        return reprotect(out, index);
      };
      const result = path.reduce(getter, this);

      return result.isNull() ? undefined : result;
    } finally {
      unprotectIndex(index);
    }
  }

  set(prop: string | number, value: RObject | WebRDataRaw): RObject {
    const prot = { n: 0 };

    try {
      const idx = new RObject(prop);
      protectInc(idx, prot);

      const valueObj = new RObject(value);
      protectInc(valueObj, prot);

      const assign = new RSymbol('[[<-');
      const call = Module._Rf_lang4(assign.ptr, this.ptr, idx.ptr, valueObj.ptr);
      protectInc(call, prot);

      return RObject.wrap(safeEval(call, objs.baseEnv));
    } finally {
      unprotect(prot.n);
    }
  }

  /** @internal */
  static getMethods(obj: RObject) {
    const props = new Set<string>();
    let cur: unknown = obj;
    do {
      Object.getOwnPropertyNames(cur).map((p) => props.add(p));
    } while ((cur = Object.getPrototypeOf(cur)));
    return [...props.keys()].filter((i) => typeof obj[i as keyof typeof obj] === 'function');
  }
}

export class RNull extends RObject {
  constructor() {
    super(new RObjectBase(Module.getValue(Module._R_NilValue, '*')));
    return this;
  }

  toJs(): WebRDataJsNull {
    return { type: 'null' };
  }
}

export class RSymbol extends RObject {
  // Note that symbols don't need to be protected. This also means
  // that allocating symbols in loops with random data is probably a
  // bad idea because this leaks memory.
  constructor(x: WebRDataScalar<string>) {
    if (x instanceof RObjectBase) {
      assertRType(x, 'symbol');
      super(x);
      return;
    }
    const name = Module.allocateUTF8(x as string);
    try {
      super(new RObjectBase(Module._Rf_install(name)));
    } finally {
      Module._free(name);
    }
  }

  toJs(): WebRDataJsSymbol {
    const obj = this.toObject();
    return {
      type: 'symbol',
      printname: obj.printname,
      symvalue: obj.symvalue,
      internal: obj.internal,
    };
  }

  toObject(): {
    printname: string | null;
    symvalue: RPtr | null;
    internal: RPtr | null;
  } {
    return {
      printname: this.printname().isUnbound() ? null : this.printname().toString(),
      symvalue: this.symvalue().isUnbound() ? null : this.symvalue().ptr,
      internal: this.internal().isNull() ? null : this.internal().ptr,
    };
  }

  toString(): string {
    return this.printname().toString();
  }

  printname(): RString {
    return RString.wrap(Module._PRINTNAME(this.ptr));
  }
  symvalue(): RObject {
    return RObject.wrap(Module._SYMVALUE(this.ptr));
  }
  internal(): RObject {
    return RObject.wrap(Module._INTERNAL(this.ptr));
  }
}

export class RPairlist extends RObject {
  constructor(val: WebRData) {
    if (val instanceof RObjectBase) {
      assertRType(val, 'pairlist');
      super(val);
      return this;
    }

    const prot = { n: 0 };

    try {
      const { names, values } = toWebRData(val);

      const list = RPairlist.wrap(Module._Rf_allocList(values.length));
      protectInc(list, prot);

      for (
        let [i, next] = [0, list as Nullable<RPairlist>];
        !next.isNull();
        [i, next] = [i + 1, next.cdr()]
      ) {
        next.setcar(new RObject(values[i]));
      }

      list.setNames(names);
      super(list);
    } finally {
      unprotect(prot.n);
    }
  }

  get length(): number {
    return this.toArray().length;
  }

  toArray(options: ToJsOptions = { depth: 1 }): WebRData[] {
    return this.toJs(options).values;
  }

  toObject({
    allowDuplicateKey = true,
    allowEmptyKey = false,
    depth = -1,
  } = {}): NamedObject<WebRData> {
    const entries = this.entries({ depth });
    const keys = entries.map(([k,]) => k);
    if (!allowDuplicateKey && new Set(keys).size !== keys.length) {
      throw new Error('Duplicate key when converting pairlist without allowDuplicateKey enabled');
    }
    if (!allowEmptyKey && keys.some((k) => !k)) {
      throw new Error('Empty or null key when converting pairlist without allowEmptyKey enabled');
    }
    return Object.fromEntries(
      entries.filter((u, idx) => entries.findIndex((v) => v[0] === u[0]) === idx)
    ) as NamedObject<WebRData>;
  }

  entries(options: ToJsOptions = { depth: 1 }): NamedEntries<WebRData> {
    const obj = this.toJs(options);
    return obj.values.map((v, i) => [obj.names ? obj.names[i] : null, v]);
  }

  toJs(options: ToJsOptions = { depth: 0 }, depth = 1): WebRDataJsNode {
    const namesArray: string[] = [];
    let hasNames = false;
    const values: WebRDataJsNode['values'] = [];

    for (let next = this as Nullable<RPairlist>; !next.isNull(); next = next.cdr()) {
      const symbol = next.tag();
      if (symbol.isNull()) {
        namesArray.push('');
      } else {
        hasNames = true;
        namesArray.push(symbol.toString());
      }
      if (options.depth && depth >= options.depth) {
        values.push(next.car());
      } else {
        values.push(next.car().toJs(options, depth + 1));
      }
    }
    const names = hasNames ? namesArray : null;
    return { type: 'pairlist', names, values };
  }

  includes(name: string): boolean {
    return name in this.toObject();
  }

  setcar(obj: RObject): void {
    Module._SETCAR(this.ptr, obj.ptr);
  }

  car(): RObject {
    return RObject.wrap(Module._CAR(this.ptr));
  }

  cdr(): Nullable<RPairlist> {
    return RObject.wrap(Module._CDR(this.ptr)) as Nullable<RPairlist>;
  }

  tag(): Nullable<RSymbol> {
    return RObject.wrap(Module._TAG(this.ptr)) as Nullable<RSymbol>;
  }
}

export class RCall extends RObject {
  constructor(val: WebRData) {
    if (val instanceof RObjectBase) {
      assertRType(val, 'call');
      super(val);
      return this;
    }
    const prot = { n: 0 };

    try {
      const { values } = toWebRData(val);
      const objs = values.map((value) => protectInc(new RObject(value), prot));
      const call = RCall.wrap(Module._Rf_allocVector(RTypeMap.call, values.length));
      protectInc(call, prot);

      for (
        let [i, next] = [0, call as Nullable<RPairlist>];
        !next.isNull();
        [i, next] = [i + 1, next.cdr()]
      ) {
        next.setcar(objs[i]);
      }
      super(call);
    } finally {
      unprotect(prot.n);
    }
  }

  setcar(obj: RObject): void {
    Module._SETCAR(this.ptr, obj.ptr);
  }

  car(): RObject {
    return RObject.wrap(Module._CAR(this.ptr));
  }

  cdr(): Nullable<RPairlist> {
    return RObject.wrap(Module._CDR(this.ptr)) as Nullable<RPairlist>;
  }

  eval(): RObject {
    return Module.webr.evalR(this, { env: objs.baseEnv });
  }

  capture(options: EvalROptions = {}) {
    return Module.webr.captureR(this, options);
  }

  deparse(): string {
    const prot = { n: 0 };
    try {
      const call = Module._Rf_lang2(
        new RSymbol('deparse1').ptr,
        Module._Rf_lang2(new RSymbol('quote').ptr, this.ptr)
      );
      protectInc(call, prot);

      const val = RCharacter.wrap(safeEval(call, objs.baseEnv));
      protectInc(val, prot);

      return val.toString();
    } finally {
      unprotect(prot.n);
    }
  }
}

export class RList extends RObject {
  constructor(val: WebRData, names: (string | null)[] | null = null) {
    if (val instanceof RObjectBase) {
      assertRType(val, 'list');
      super(val);
      if (names) {
        if (names.length !== this.length) {
          throw new Error(
            "Can't construct named `RList`. Supplied `names` must be the same length as the list."
          );
        }
        this.setNames(names);
      }
      return this;
    }

    const prot = { n: 0 };

    try {
      const data = toWebRData(val);
      const ptr = Module._Rf_allocVector(RTypeMap.list, data.values.length);
      protectInc(ptr, prot);

      data.values.forEach((v, i) => {
        // When we specifically use the `RList` constructor, deeply convert R objects to R lists
        if (isSimpleObject(v)) {
          Module._SET_VECTOR_ELT(ptr, i, new RList(v).ptr);
        } else {
          Module._SET_VECTOR_ELT(ptr, i, new RObject(v).ptr);
        }
      });

      const _names = names ? names : data.names;
      if (_names && _names.length !== data.values.length) {
        throw new Error(
          "Can't construct named `RList`. Supplied `names` must be the same length as the list."
        );
      }
      RObject.wrap(ptr).setNames(_names);

      super(new RObjectBase(ptr));
    } finally {
      unprotect(prot.n);
    }
  }

  get length(): number {
    return Module._LENGTH(this.ptr);
  }

  isDataFrame(): boolean {
    const classes = RPairlist.wrap(Module._ATTRIB(this.ptr)).get('class') as RNull | RCharacter;
    return !classes.isNull() && classes.toArray().includes('data.frame');
  }

  toArray(options: { depth: number } = { depth: 1 }): WebRData[] {
    return this.toJs(options).values;
  }

  toObject({
    allowDuplicateKey = true,
    allowEmptyKey = false,
    depth = -1,
  } = {}): NamedObject<WebRData> {
    const entries = this.entries({ depth });
    const keys = entries.map(([k,]) => k);
    if (!allowDuplicateKey && new Set(keys).size !== keys.length) {
      throw new Error('Duplicate key when converting list without allowDuplicateKey enabled');
    }
    if (!allowEmptyKey && keys.some((k) => !k)) {
      throw new Error('Empty or null key when converting list without allowEmptyKey enabled');
    }
    return Object.fromEntries(
      entries.filter((u, idx) => entries.findIndex((v) => v[0] === u[0]) === idx)
    ) as NamedObject<WebRData>;
  }

  toD3(): NamedObject<WebRData>[] {
    if (!this.isDataFrame()) {
      throw new Error(
        "Can't convert R list object to D3 format. Object must be of class 'data.frame'."
      );
    }
    const entries = this.entries() as Array<[string, atomicType[]]>;
    return entries.reduce((a, entry) => {
      entry[1].forEach((v, j) => a[j] = Object.assign(a[j] || {}, { [entry[0]!]: v }));
      return a;
    }, []);
  }

  entries(options: { depth: number } = { depth: -1 }): NamedEntries<WebRData> {
    const obj = this.toJs(options);

    // If this is a data frame, assume we have atomic vector columns and can
    // convert directly to array values by default.
    if (this.isDataFrame() && options.depth < 0) {
      obj.values = (obj.values as RVectorAtomic<atomicType>[]).map((v) => v.toArray());
    }
    return obj.values.map((v, i) => [obj.names ? obj.names[i] : null, v]);
  }

  toJs(options: { depth: number } = { depth: 0 }, depth = 1): WebRDataJsNode {
    return {
      type: 'list',
      names: this.names(),
      values: [...Array(this.length).keys()].map((i) => {
        if (options.depth && depth >= options.depth) {
          return this.get(i + 1);
        } else {
          return this.get(i + 1).toJs(options, depth + 1);
        }
      }),
    };
  }
}

export class RDataFrame extends RList {
  constructor(val: WebRData) {
    if (val instanceof RObjectBase) {
      super(val);
      if (!this.isDataFrame()) {
        throw new Error("Can't construct `RDataFrame`. Supplied R object is not a `data.frame`.");
      }
      return this;
    }
    return RDataFrame.fromObject(val);
  }

  static fromObject(obj: WebRData) {
    const { names, values } = toWebRData(obj);
    const prot = { n: 0 };

    // Do we have consistent columns of atomic type? If so, make a `data.frame`.
    try {
      const hasNames = !!names && names.length > 0 && names.every((v) => v);
      const hasArrays = values.length > 0 && values.every((v) => {
        return Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
      });

      if (hasNames && hasArrays) {
        const _values = values as WebRData[][];
        const isConsistentLength = _values.every((a) => a.length === _values[0].length);
        const isAtomic = _values.every((a) => {
          return isAtomicType(a[0]) || isRVectorAtomic(a[0]);
        });

        if (isConsistentLength && isAtomic) {
          const listObj = new RList({
            type: 'list',
            names: names,
            values: _values.map((a) => newObjectFromData(a))
          });
          protectInc(listObj, prot);

          const asDataFrame = new RCall([new RSymbol('as.data.frame'), listObj]);
          protectInc(asDataFrame, prot);

          return new RDataFrame(asDataFrame.eval());
        }
      }
    } finally {
      unprotect(prot.n);
    }

    // Not eligible as a `data.frame`, throw an error.
    throw new Error("Can't construct `data.frame`. Source object is not eligible.");
  }

  static fromD3(arr: { [key: string]: WebRData }[]) {
    return this.fromObject(
      Object.fromEntries(Object.keys(arr[0]).map((k) => [k, arr.map((v) => v[k])]))
    );
  }
}

export class RFunction extends RObject {
  exec(...args: (WebRDataRaw | RObject)[]): RObject {
    const prot = { n: 0 };

    try {
      const call = new RCall([this, ...args]);
      protectInc(call, prot);
      return call.eval();
    } finally {
      unprotect(prot.n);
    }
  }

  capture(options: EvalROptions = {}, ...args: (WebRDataRaw | RObject)[]) {
    const prot = { n: 0 };

    try {
      const call = new RCall([this, ...args]);
      protectInc(call, prot);
      return call.capture(options);
    } finally {
      unprotect(prot.n);
    }
  }
}

export class RString extends RObject {
  static CEType = {
    CE_NATIVE: 0,
    CE_UTF8: 1,
    CE_LATIN1: 2,
    CE_BYTES: 3,
    CE_SYMBOL: 5,
    CE_ANY: 99
  } as const;

  // Unlike symbols, strings are not cached and must thus be protected
  constructor(x: WebRDataScalar<string>) {
    if (x instanceof RObjectBase) {
      assertRType(x, 'string');
      super(x);
      return;
    }

    const name = Module.allocateUTF8(x as string);

    try {
      super(new RObjectBase(Module._Rf_mkCharCE(name, RString.CEType.CE_UTF8)));
    } finally {
      Module._free(name);
    }
  }

  toString(): string {
    const vmax = Module._vmaxget();
    try {
      return Module.UTF8ToString(Module._Rf_translateCharUTF8(this.ptr));
    } finally {
      Module._vmaxset(vmax);
    }
  }

  toJs(): WebRDataJsString {
    return {
      type: 'string',
      value: this.toString(),
    };
  }
}

export class REnvironment extends RObject {
  constructor(val: WebRData = {}) {
    if (val instanceof RObjectBase) {
      assertRType(val, 'environment');
      super(val);
      return this;
    }
    let nProt = 0;

    try {
      const { names, values } = toWebRData(val);

      const ptr = protect(Module._R_NewEnv(objs.globalEnv.ptr, 0, 0));
      ++nProt;

      values.forEach((v, i) => {
        const name = names ? names[i] : null;
        if (!name) {
          throw new Error("Can't create object in new environment with empty symbol name");
        }

        const sym = new RSymbol(name);
        const vObj = protect(new RObject(v));
        try {
          envPoke(ptr, sym, vObj);
        } finally {
          unprotect(1);
        }
      });

      super(new RObjectBase(ptr));
    } finally {
      unprotect(nProt);
    }
  }

  ls(all = false, sorted = true): string[] {
    const ls = RCharacter.wrap(Module._R_lsInternal3(this.ptr, Number(all), Number(sorted)));
    return ls.toArray() as string[];
  }

  bind(name: string, value: WebRData): void {
    const sym = new RSymbol(name);
    const valueObj = protect(new RObject(value));

    try {
      envPoke(this, sym, valueObj);
    } finally {
      unprotect(1);
    }
  }

  names(): string[] {
    return this.ls(true, true);
  }

  frame(): RObject {
    return RObject.wrap(Module._FRAME(this.ptr));
  }

  subset(prop: number | string): RObject {
    if (typeof prop === 'number') {
      throw new Error('Object of type environment is not subsettable');
    }
    return this.getDollar(prop);
  }

  toObject({ depth = -1 } = {}): NamedObject<WebRData> {
    const symbols = this.names();
    return Object.fromEntries(
      [...Array(symbols.length).keys()].map((i) => {
        const value = this.getDollar(symbols[i]);
        return [symbols[i], depth < 0 ? value : value.toJs({ depth })];
      })
    );
  }

  toJs(options: { depth: number } = { depth: 0 }, depth = 1): WebRDataJsNode {
    const names = this.names();
    const values = [...Array(names.length).keys()].map((i) => {
      if (options.depth && depth >= options.depth) {
        return this.getDollar(names[i]);
      } else {
        return this.getDollar(names[i]).toJs(options, depth + 1);
      }
    });

    return {
      type: 'environment',
      names,
      values,
    };
  }
}

type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type atomicType = number | boolean | Complex | string;

abstract class RVectorAtomic<T extends atomicType> extends RObject {
  constructor(
    val: WebRDataAtomic<T>,
    kind: RType,
    newSetter: (ptr: RPtr) => (v: any, i: number) => void
  ) {
    if (val instanceof RObjectBase) {
      assertRType(val, kind);
      super(val);
      return this;
    }

    const prot = { n: 0 };

    try {
      const { names, values } = toWebRData(val);

      const ptr = Module._Rf_allocVector(RTypeMap[kind], values.length);
      protectInc(ptr, prot);

      values.forEach(newSetter(ptr));
      RObject.wrap(ptr).setNames(names);

      super(new RObjectBase(ptr));
    } finally {
      unprotect(prot.n);
    }
  }

  get length(): number {
    return Module._LENGTH(this.ptr);
  }

  get(prop: number | string): this {
    return super.get(prop) as this;
  }

  subset(prop: number | string): this {
    return super.subset(prop) as this;
  }

  getDollar(): RObject {
    throw new Error('$ operator is invalid for atomic vectors');
  }

  detectMissing(): boolean[] {
    const prot = { n: 0 };

    try {
      const call = Module._Rf_lang2(new RSymbol('is.na').ptr, this.ptr);
      protectInc(call, prot);

      const val = RLogical.wrap(safeEval(call, objs.baseEnv));
      protectInc(val, prot);

      const ret = val.toTypedArray();
      return Array.from(ret).map((elt) => Boolean(elt));
    } finally {
      unprotect(prot.n);
    }
  }

  abstract toTypedArray(): TypedArray;

  toArray(): (T | null)[] {
    const arr = this.toTypedArray();
    return this.detectMissing().map((m, idx) => (m ? null : (arr[idx] as T)));
  }

  toObject({ allowDuplicateKey = true, allowEmptyKey = false } = {}): NamedObject<T | null> {
    const entries = this.entries();
    const keys = entries.map(([k,]) => k);
    if (!allowDuplicateKey && new Set(keys).size !== keys.length) {
      throw new Error(
        'Duplicate key when converting atomic vector without allowDuplicateKey enabled'
      );
    }
    if (!allowEmptyKey && keys.some((k) => !k)) {
      throw new Error(
        'Empty or null key when converting atomic vector without allowEmptyKey enabled'
      );
    }
    return Object.fromEntries(
      entries.filter((u, idx) => entries.findIndex((v) => v[0] === u[0]) === idx)
    ) as NamedObject<T | null>;
  }

  entries(): NamedEntries<T | null> {
    const values = this.toArray();
    const names = this.names();
    return values.map((v, i) => [names ? names[i] : null, v]);
  }

  toJs(): WebRDataJsAtomic<T> {
    return {
      type: this.type() as 'logical' | 'integer' | 'double' | 'complex' | 'character' | 'raw',
      names: this.names(),
      values: this.toArray(),
    };
  }
}

export class RLogical extends RVectorAtomic<boolean> {
  constructor(val: WebRDataAtomic<boolean>) {
    super(val, 'logical', RLogical.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    const data = Module._LOGICAL(ptr);
    const naLogical = Module.getValue(Module._R_NaInt, 'i32');
    return (v: null | boolean, i: number) => {
      Module.setValue(data + 4 * i, v === null ? naLogical : Boolean(v), 'i32');
    };
  };

  getBoolean(idx: number): boolean | null {
    return this.get(idx).toArray()[0];
  }

  toBoolean(): boolean {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getBoolean(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS boolean");
    }
    return val;
  }

  toTypedArray(): Int32Array {
    return new Int32Array(
      Module.HEAP32.subarray(
        Module._LOGICAL(this.ptr) / 4,
        Module._LOGICAL(this.ptr) / 4 + this.length
      )
    );
  }

  toArray(): (boolean | null)[] {
    const arr = this.toTypedArray();
    return this.detectMissing().map((m, idx) => (m ? null : Boolean(arr[idx])));
  }
}

export class RInteger extends RVectorAtomic<number> {
  constructor(val: WebRDataAtomic<number>) {
    super(val, 'integer', RInteger.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    const data = Module._INTEGER(ptr);
    const naInteger = Module.getValue(Module._R_NaInt, 'i32');

    return (v: null | number, i: number) => {
      Module.setValue(data + 4 * i, v === null ? naInteger : Math.round(Number(v)), 'i32');
    };
  };

  getNumber(idx: number): number | null {
    return this.get(idx).toArray()[0];
  }

  toNumber(): number {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getNumber(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS number");
    }
    return val;
  }

  toTypedArray(): Int32Array {
    return new Int32Array(
      Module.HEAP32.subarray(
        Module._INTEGER(this.ptr) / 4,
        Module._INTEGER(this.ptr) / 4 + this.length
      )
    );
  }
}

export class RDouble extends RVectorAtomic<number> {
  constructor(val: WebRDataAtomic<number>) {
    super(val, 'double', RDouble.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    const data = Module._REAL(ptr);
    const naDouble = Module.getValue(Module._R_NaReal, 'double');

    return (v: null | number, i: number) => {
      Module.setValue(data + 8 * i, v === null ? naDouble : v, 'double');
    };
  };

  getNumber(idx: number): number | null {
    return this.get(idx).toArray()[0];
  }

  toNumber(): number {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getNumber(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS number");
    }
    return val;
  }

  toTypedArray(): Float64Array {
    return new Float64Array(
      Module.HEAPF64.subarray(Module._REAL(this.ptr) / 8, Module._REAL(this.ptr) / 8 + this.length)
    );
  }
}

export class RComplex extends RVectorAtomic<Complex> {
  constructor(val: WebRDataAtomic<Complex>) {
    super(val, 'complex', RComplex.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    const data = Module._COMPLEX(ptr);
    const naDouble = Module.getValue(Module._R_NaReal, 'double');

    return (v: null | Complex, i: number) => {
      Module.setValue(data + 8 * (2 * i), v === null ? naDouble : v.re, 'double');
      Module.setValue(data + 8 * (2 * i + 1), v === null ? naDouble : v.im, 'double');
    };
  };

  getComplex(idx: number): Complex | null {
    return this.get(idx).toArray()[0];
  }

  toComplex(): Complex {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getComplex(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS object");
    }
    return val;
  }

  toTypedArray(): Float64Array {
    return new Float64Array(
      Module.HEAPF64.subarray(
        Module._COMPLEX(this.ptr) / 8,
        Module._COMPLEX(this.ptr) / 8 + 2 * this.length
      )
    );
  }

  toArray(): (Complex | null)[] {
    const arr = this.toTypedArray();
    return this.detectMissing().map((m, idx) =>
      m ? null : { re: arr[2 * idx], im: arr[2 * idx + 1] }
    );
  }
}

export class RCharacter extends RVectorAtomic<string> {
  constructor(val: WebRDataAtomic<string>) {
    super(val, 'character', RCharacter.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    return (v: null | string, i: number) => {
      if (v === null) {
        Module._SET_STRING_ELT(ptr, i, objs.naString.ptr);
      } else {
        Module._SET_STRING_ELT(ptr, i, new RString(v).ptr);
      }
    };
  };

  getString(idx: number): string | null {
    return this.get(idx).toArray()[0];
  }

  toString(): string {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getString(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS string");
    }
    return val;
  }

  toTypedArray(): Uint32Array {
    return new Uint32Array(
      Module.HEAPU32.subarray(
        Module._STRING_PTR(this.ptr) / 4,
        Module._STRING_PTR(this.ptr) / 4 + this.length
      )
    );
  }

  toArray(): (string | null)[] {
    const vmax = Module._vmaxget();
    try {
      return this.detectMissing().map((m, idx) =>
        m ? null : Module.UTF8ToString(
          Module._Rf_translateCharUTF8(Module._STRING_ELT(this.ptr, idx))
        )
      );
    } finally {
      Module._vmaxset(vmax);
    }
  }
}

export class RRaw extends RVectorAtomic<number> {
  constructor(val: WebRDataAtomic<number>) {
    if (val instanceof ArrayBuffer) {
      val = new Uint8Array(val);
    }
    super(val, 'raw', RRaw.#newSetter);
  }

  static #newSetter = (ptr: RPtr) => {
    const data = Module._RAW(ptr);

    return (v: number, i: number) => {
      Module.setValue(data + i, Number(v), 'i8');
    };
  };

  getNumber(idx: number): number | null {
    return this.get(idx).toArray()[0];
  }

  toNumber(): number {
    if (this.length !== 1) {
      throw new Error("Can't convert atomic vector of length > 1 to a scalar JS value");
    }
    const val = this.getNumber(1);
    if (val === null) {
      throw new Error("Can't convert missing value `NA` to a JS number");
    }
    return val;
  }

  toTypedArray(): Uint8Array {
    return new Uint8Array(
      Module.HEAPU8.subarray(Module._RAW(this.ptr), Module._RAW(this.ptr) + this.length)
    );
  }
}

/*
 * Convert the various types possible in the type union WebRData into
 * consistently typed arrays of names and values.
 */
function toWebRData<T>(jsObj: WebRDataAtomic<T>): {
  names: (string | null)[] | null;
  values: (T | null)[];
};
function toWebRData(jsObj: WebRData): WebRData;
function toWebRData(jsObj: WebRData): WebRData {
  if (isWebRDataJs(jsObj)) {
    return jsObj;
  } else if (Array.isArray(jsObj) || ArrayBuffer.isView(jsObj)) {
    return { names: null, values: jsObj };
  } else if (jsObj && typeof jsObj === 'object' && !isComplex(jsObj)) {
    return {
      names: Object.keys(jsObj),
      values: Object.values(jsObj),
    };
  }
  return { names: null, values: [jsObj] };
}

export function getRWorkerClass(type: RType | RCtor): typeof RObject {
  const typeClasses: { [key: string]: typeof RObject } = {
    object: RObject,
    null: RNull,
    symbol: RSymbol,
    pairlist: RPairlist,
    closure: RFunction,
    environment: REnvironment,
    call: RCall,
    special: RFunction,
    builtin: RFunction,
    string: RString,
    logical: RLogical,
    integer: RInteger,
    double: RDouble,
    complex: RComplex,
    character: RCharacter,
    list: RList,
    raw: RRaw,
    function: RFunction,
    dataframe: RDataFrame,
  };
  if (type in typeClasses) {
    return typeClasses[type];
  }
  return RObject;
}

/**
 * Test for an RWorker.RObject instance.
 *
 * RWorker.RObject is the internal interface to R objects, intended to be used
 * on the worker thread.
 *
 * @private
 * @param {any} value The object to test.
 * @return {boolean} True if the object is an instance of an RObject.
 */
export function isRObject(value: any): value is RObject {
  return value instanceof RObject;
}

/**
 * Test for an RWorker.RVectorAtomic instance.
 *
 * @private
 * @param {any} value The object to test.
 * @return {boolean} True if the object is an instance of an RVectorAtomic.
 */
export function isRVectorAtomic(value: any): value is RVectorAtomic<atomicType> {
  const atomicRTypes = ['logical', 'integer', 'double', 'complex', 'character'];

  return (
    (isRObject(value) && atomicRTypes.includes(value.type()))
    || (isRObject(value) && value.isNa())
  );
}

/**
 * Test for an atomicType, including missing `null` values.
 *
 * @private
 * @param {any} value The object to test.
 * @return {boolean} True if the object is of type atomicType.
 */
export function isAtomicType(value: any): value is atomicType | null {
  return (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'string'
    || isComplex(value)
  );
}

/**
 * A store for persistent R objects, initialised at R startup.
 */
export let objs: {
  baseEnv: REnvironment,
  bracket2Symbol: RSymbol,
  bracketSymbol: RSymbol,
  dollarSymbol: RSymbol,
  emptyEnv: REnvironment,
  false: RLogical,
  globalEnv: REnvironment,
  na: RLogical,
  namesSymbol: RSymbol,
  naString: RObject,
  null: RNull,
  true: RLogical,
  unboundValue: RObject,
};

/**
 * Populate the persistent R object store.
 * @internal
 */
export function initPersistentObjects() {
  objs = {
    baseEnv: REnvironment.wrap(Module.getValue(Module._R_BaseEnv, '*')),
    bracket2Symbol: RSymbol.wrap(Module.getValue(Module._R_Bracket2Symbol, '*')),
    bracketSymbol: RSymbol.wrap(Module.getValue(Module._R_BracketSymbol, '*')),
    dollarSymbol: RSymbol.wrap(Module.getValue(Module._R_DollarSymbol, '*')),
    emptyEnv: REnvironment.wrap(Module.getValue(Module._R_EmptyEnv, '*')),
    false: RLogical.wrap(Module.getValue(Module._R_FalseValue, '*')),
    globalEnv: REnvironment.wrap(Module.getValue(Module._R_GlobalEnv, '*')),
    na: RLogical.wrap(Module.getValue(Module._R_LogicalNAValue, '*')),
    namesSymbol: RSymbol.wrap(Module.getValue(Module._R_NamesSymbol, '*')),
    naString: RObject.wrap(Module.getValue(Module._R_NaString, '*')),
    null: RNull.wrap(Module.getValue(Module._R_NilValue, '*')),
    true: RLogical.wrap(Module.getValue(Module._R_TrueValue, '*')),
    unboundValue: RObject.wrap(Module.getValue(Module._R_UnboundValue, '*')),
  };
}
