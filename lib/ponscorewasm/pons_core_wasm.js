let wasm;

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

const AdaptiveFecFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_adaptivefec_free(ptr >>> 0, 1));

const BenchmarkResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_benchmarkresult_free(ptr >>> 0, 1));

const ChunkPoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_chunkpool_free(ptr >>> 0, 1));

const CommitResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_commitresult_free(ptr >>> 0, 1));

const Crc32HasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_crc32hasher_free(ptr >>> 0, 1));

const CryptoSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cryptosession_free(ptr >>> 0, 1));

const EncryptedPacketHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedpacketheader_free(ptr >>> 0, 1));

const FileSignatureDetectorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_filesignaturedetector_free(ptr >>> 0, 1));

const FileTypeResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_filetyperesult_free(ptr >>> 0, 1));

const Lz4CompressorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lz4compressor_free(ptr >>> 0, 1));

const MerkleTreeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_merkletree_free(ptr >>> 0, 1));

const PacketDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetdecoder_free(ptr >>> 0, 1));

const PacketEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetencoder_free(ptr >>> 0, 1));

const PacketHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetheader_free(ptr >>> 0, 1));

const ParallelCryptoSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parallelcryptosession_free(ptr >>> 0, 1));

const ParallelDecryptResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_paralleldecryptresult_free(ptr >>> 0, 1));

const ParallelEncryptResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parallelencryptresult_free(ptr >>> 0, 1));

const ProofNodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proofnode_free(ptr >>> 0, 1));

const ReedSolomonDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_reedsolomondecoder_free(ptr >>> 0, 1));

const ReedSolomonEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_reedsolomonencoder_free(ptr >>> 0, 1));

const SlotInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_slotinfo_free(ptr >>> 0, 1));

const WasmReorderingBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmreorderingbuffer_free(ptr >>> 0, 1));

const ZeroCopyBatchPoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zerocopybatchpool_free(ptr >>> 0, 1));

const ZeroCopyPacketPoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zerocopypacketpool_free(ptr >>> 0, 1));

const Zip64StreamFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zip64stream_free(ptr >>> 0, 1));

/**
 * 적응형 FEC 레벨 관리자
 *
 * 네트워크 상태에 따라 패리티 레벨을 동적으로 조정합니다.
 */
export class AdaptiveFec {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AdaptiveFec.prototype);
        obj.__wbg_ptr = ptr;
        AdaptiveFecFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AdaptiveFecFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_adaptivefec_free(ptr, 0);
    }
    /**
     * 패킷 손실 보고
     *
     * - total_sent: 전송한 총 패킷 수
     * - lost: 손실된 패킷 수
     * @param {number} total_sent
     * @param {number} lost
     */
    report_loss(total_sent, lost) {
        wasm.adaptivefec_report_loss(this.__wbg_ptr, total_sent, lost);
    }
    /**
     * 기본 설정 (10 data, 2-6 parity)
     * @returns {AdaptiveFec}
     */
    static withDefaults() {
        const ret = wasm.adaptivefec_withDefaults();
        return AdaptiveFec.__wrap(ret);
    }
    /**
     * 디코더 생성
     * @param {number} shard_size
     * @returns {ReedSolomonDecoder}
     */
    create_decoder(shard_size) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.adaptivefec_create_decoder(retptr, this.__wbg_ptr, shard_size);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return ReedSolomonDecoder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 인코더 생성
     * @returns {ReedSolomonEncoder}
     */
    create_encoder() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.adaptivefec_create_encoder(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return ReedSolomonEncoder.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 현재 패리티 샤드 수
     * @returns {number}
     */
    get current_parity() {
        const ret = wasm.adaptivefec_current_parity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 현재 오버헤드 비율 (패리티/데이터)
     * @returns {number}
     */
    get overhead_ratio() {
        const ret = wasm.adaptivefec_overhead_ratio(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} data_shards
     * @param {number} min_parity
     * @param {number} max_parity
     */
    constructor(data_shards, min_parity, max_parity) {
        const ret = wasm.adaptivefec_new(data_shards, min_parity, max_parity);
        this.__wbg_ptr = ret >>> 0;
        AdaptiveFecFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 리셋
     */
    reset() {
        wasm.adaptivefec_reset(this.__wbg_ptr);
    }
    /**
     * 현재 손실률
     * @returns {number}
     */
    get loss_rate() {
        const ret = wasm.adaptivefec_loss_rate(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) AdaptiveFec.prototype[Symbol.dispose] = AdaptiveFec.prototype.free;

/**
 * 벤치마크 결과
 */
export class BenchmarkResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(BenchmarkResult.prototype);
        obj.__wbg_ptr = ptr;
        BenchmarkResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BenchmarkResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_benchmarkresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get iterations() {
        const ret = wasm.__wbg_get_benchmarkresult_iterations(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set iterations(arg0) {
        wasm.__wbg_set_benchmarkresult_iterations(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {bigint}
     */
    get total_bytes() {
        const ret = wasm.__wbg_get_benchmarkresult_total_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set total_bytes(arg0) {
        wasm.__wbg_set_benchmarkresult_total_bytes(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get duration_ms() {
        const ret = wasm.__wbg_get_benchmarkresult_duration_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set duration_ms(arg0) {
        wasm.__wbg_set_benchmarkresult_duration_ms(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get throughput_mbps() {
        const ret = wasm.__wbg_get_benchmarkresult_throughput_mbps(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set throughput_mbps(arg0) {
        wasm.__wbg_set_benchmarkresult_throughput_mbps(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get packets_per_sec() {
        const ret = wasm.__wbg_get_benchmarkresult_packets_per_sec(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set packets_per_sec(arg0) {
        wasm.__wbg_set_benchmarkresult_packets_per_sec(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) BenchmarkResult.prototype[Symbol.dispose] = BenchmarkResult.prototype.free;

export class ChunkPool {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ChunkPoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_chunkpool_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get chunk_size() {
        const ret = wasm.chunkpool_chunk_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} count
     */
    preallocate(count) {
        wasm.chunkpool_preallocate(this.__wbg_ptr, count);
    }
    /**
     * @param {number} chunk_size
     * @param {number} max_pool_size
     */
    constructor(chunk_size, max_pool_size) {
        const ret = wasm.chunkpool_new(chunk_size, max_pool_size);
        this.__wbg_ptr = ret >>> 0;
        ChunkPoolFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    clear() {
        wasm.chunkpool_clear(this.__wbg_ptr);
    }
    /**
     * @returns {Uint8Array}
     */
    acquire() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.chunkpool_acquire(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} buffer
     */
    release(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.chunkpool_release(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {number}
     */
    get pool_size() {
        const ret = wasm.chunkpool_pool_size(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ChunkPool.prototype[Symbol.dispose] = ChunkPool.prototype.free;

/**
 * 배치 커밋 결과
 */
export class CommitResult {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CommitResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_commitresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get slot_id() {
        const ret = wasm.__wbg_get_commitresult_slot_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set slot_id(arg0) {
        wasm.__wbg_set_commitresult_slot_id(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get packet_ptr() {
        const ret = wasm.__wbg_get_commitresult_packet_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set packet_ptr(arg0) {
        wasm.__wbg_set_commitresult_packet_ptr(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get packet_len() {
        const ret = wasm.__wbg_get_commitresult_packet_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set packet_len(arg0) {
        wasm.__wbg_set_commitresult_packet_len(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) CommitResult.prototype[Symbol.dispose] = CommitResult.prototype.free;

export class Crc32Hasher {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Crc32HasherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_crc32hasher_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.crc32hasher_new();
        this.__wbg_ptr = ret >>> 0;
        Crc32HasherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    reset() {
        wasm.crc32hasher_reset(this.__wbg_ptr);
    }
    /**
     * @param {Uint8Array} data
     */
    update(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.crc32hasher_update(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {number}
     */
    finalize() {
        const ret = wasm.crc32hasher_finalize(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Crc32Hasher.prototype[Symbol.dispose] = Crc32Hasher.prototype.free;

/**
 * 세션 암호화 컨텍스트
 */
export class CryptoSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CryptoSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_cryptosession_free(ptr, 0);
    }
    /**
     * 청크 복호화
     * @param {Uint8Array} packet
     * @returns {Uint8Array}
     */
    decrypt_chunk(packet) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.cryptosession_decrypt_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 청크 암호화 (패킷 생성 포함)
     * @param {Uint8Array} plaintext
     * @returns {Uint8Array}
     */
    encrypt_chunk(plaintext) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.cryptosession_encrypt_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 🚀 [신규] In-Place 암호화 (Zero-Copy 지원)
     *
     * WASM 메모리 내의 데이터를 직접 암호화하여 불필요한 할당과 복사를 제거합니다.
     * - buffer: 전체 패킷 버퍼 (헤더 공간 포함)
     * - data_offset: 데이터가 시작되는 오프셋
     * - data_len: 데이터 길이
     *
     * Returns: (nonce + tag)가 합쳐진 Vec<u8> 반환 (헤더 작성용)
     * @param {Uint8Array} buffer
     * @param {number} data_offset
     * @param {number} data_len
     * @returns {Uint8Array}
     */
    encrypt_in_place(buffer, data_offset, data_len) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            var ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_export);
            var len0 = WASM_VECTOR_LEN;
            wasm.cryptosession_encrypt_in_place(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(buffer), data_offset, data_len);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 총 암호화된 바이트 수
     * @returns {bigint}
     */
    get total_bytes_encrypted() {
        const ret = wasm.cryptosession_total_bytes_encrypted(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 세션 키로부터 암호화 컨텍스트 생성
     * @param {Uint8Array} session_key
     * @param {Uint8Array} random_prefix
     */
    constructor(session_key, random_prefix) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(random_prefix, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            wasm.cryptosession_new(retptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            CryptoSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 리셋
     */
    reset() {
        wasm.cryptosession_reset(this.__wbg_ptr);
    }
    /**
     * 시퀀스 번호
     * @returns {number}
     */
    get sequence() {
        const ret = wasm.cryptosession_sequence(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) CryptoSession.prototype[Symbol.dispose] = CryptoSession.prototype.free;

/**
 * 암호화된 패킷 헤더
 */
export class EncryptedPacketHeader {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncryptedPacketHeader.prototype);
        obj.__wbg_ptr = ptr;
        EncryptedPacketHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptedPacketHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptedpacketheader_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get version() {
        const ret = wasm.__wbg_get_encryptedpacketheader_version(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set version(arg0) {
        wasm.__wbg_set_encryptedpacketheader_version(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get flags() {
        const ret = wasm.__wbg_get_encryptedpacketheader_flags(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set flags(arg0) {
        wasm.__wbg_set_encryptedpacketheader_flags(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get file_index() {
        const ret = wasm.__wbg_get_encryptedpacketheader_file_index(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set file_index(arg0) {
        wasm.__wbg_set_encryptedpacketheader_file_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get chunk_index() {
        const ret = wasm.__wbg_get_encryptedpacketheader_chunk_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set chunk_index(arg0) {
        wasm.__wbg_set_encryptedpacketheader_chunk_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {bigint}
     */
    get offset() {
        const ret = wasm.__wbg_get_benchmarkresult_total_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set offset(arg0) {
        wasm.__wbg_set_benchmarkresult_total_bytes(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get plaintext_length() {
        const ret = wasm.__wbg_get_encryptedpacketheader_plaintext_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set plaintext_length(arg0) {
        wasm.__wbg_set_encryptedpacketheader_plaintext_length(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {Uint8Array}
     */
    get nonce() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_encryptedpacketheader_nonce(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} arg0
     */
    set nonce(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_encryptedpacketheader_nonce(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 바이트에서 헤더 파싱
     * @param {Uint8Array} data
     * @returns {EncryptedPacketHeader | undefined}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encryptedpacketheader_from_bytes(ptr0, len0);
        return ret === 0 ? undefined : EncryptedPacketHeader.__wrap(ret);
    }
    /**
     * 암호화 여부 확인
     * @returns {boolean}
     */
    is_encrypted() {
        const ret = wasm.encryptedpacketheader_is_encrypted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 압축 여부 확인
     * @returns {boolean}
     */
    is_compressed() {
        const ret = wasm.encryptedpacketheader_is_compressed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 헤더를 바이트로 직렬화
     * @returns {Uint8Array}
     */
    to_bytes() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.encryptedpacketheader_to_bytes(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) EncryptedPacketHeader.prototype[Symbol.dispose] = EncryptedPacketHeader.prototype.free;

/**
 * 파일 시그니처 감지기
 */
export class FileSignatureDetector {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FileSignatureDetectorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_filesignaturedetector_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.filesignaturedetector_new();
        this.__wbg_ptr = ret >>> 0;
        FileSignatureDetectorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 파일 데이터에서 타입 감지
     * @param {Uint8Array} data
     * @returns {FileTypeResult}
     */
    detect(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.filesignaturedetector_detect(this.__wbg_ptr, ptr0, len0);
        return FileTypeResult.__wrap(ret);
    }
}
if (Symbol.dispose) FileSignatureDetector.prototype[Symbol.dispose] = FileSignatureDetector.prototype.free;

/**
 * 파일 타입 감지 결과
 */
export class FileTypeResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(FileTypeResult.prototype);
        obj.__wbg_ptr = ptr;
        FileTypeResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FileTypeResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_filetyperesult_free(ptr, 0);
    }
    /**
     * @param {string} mime
     * @param {string} extension
     * @param {number} confidence
     */
    constructor(mime, extension, confidence) {
        const ptr0 = passStringToWasm0(mime, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(extension, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.filetyperesult_new(ptr0, len0, ptr1, len1, confidence);
        this.__wbg_ptr = ret >>> 0;
        FileTypeResultFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {string}
     */
    get mime() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_filetyperesult_mime(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} arg0
     */
    set mime(arg0) {
        const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_filetyperesult_mime(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {string}
     */
    get extension() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_filetyperesult_extension(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} arg0
     */
    set extension(arg0) {
        const ptr0 = passStringToWasm0(arg0, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_filetyperesult_extension(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {number}
     */
    get confidence() {
        const ret = wasm.__wbg_get_filetyperesult_confidence(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set confidence(arg0) {
        wasm.__wbg_set_filetyperesult_confidence(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) FileTypeResult.prototype[Symbol.dispose] = FileTypeResult.prototype.free;

/**
 * LZ4 압축기
 */
export class Lz4Compressor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Lz4CompressorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lz4compressor_free(ptr, 0);
    }
    /**
     * 데이터 해제
     * @param {Uint8Array} input
     * @returns {Uint8Array}
     */
    decompress(input) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.lz4compressor_decompress(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {number} level
     */
    constructor(level) {
        const ret = wasm.lz4compressor_new(level);
        this.__wbg_ptr = ret >>> 0;
        Lz4CompressorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 데이터 압축
     * @param {Uint8Array} input
     * @returns {Uint8Array}
     */
    compress(input) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.lz4compressor_compress(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) Lz4Compressor.prototype[Symbol.dispose] = Lz4Compressor.prototype.free;

/**
 * Merkle Tree
 */
export class MerkleTree {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MerkleTreeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_merkletree_free(ptr, 0);
    }
    /**
     * 리프 개수
     * @returns {number}
     */
    get leaf_count() {
        const ret = wasm.merkletree_leaf_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 증명 검증
     * @param {Uint8Array} root
     * @param {Uint8Array} leaf_data
     * @param {number} _index
     * @param {Uint8Array} proof
     * @returns {boolean}
     */
    static verify_proof(root, leaf_data, _index, proof) {
        const ptr0 = passArray8ToWasm0(root, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(leaf_data, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(proof, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.merkletree_verify_proof(ptr0, len0, ptr1, len1, _index, ptr2, len2);
        return ret !== 0;
    }
    /**
     * 데이터 청크들로부터 Merkle Tree 생성
     */
    constructor() {
        const ret = wasm.merkletree_new();
        this.__wbg_ptr = ret >>> 0;
        MerkleTreeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 루트 해시 반환
     * @returns {Uint8Array}
     */
    root() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.merkletree_root(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 리셋
     */
    reset() {
        wasm.merkletree_reset(this.__wbg_ptr);
    }
    /**
     * 트리 높이
     * @returns {number}
     */
    get height() {
        const ret = wasm.merkletree_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 트리 빌드 완료
     */
    finalize() {
        wasm.merkletree_finalize(this.__wbg_ptr);
    }
    /**
     * 청크 추가 (스트리밍 빌드)
     * @param {Uint8Array} data
     */
    add_chunk(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.merkletree_add_chunk(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 특정 청크의 증명 경로 생성
     * @param {number} index
     * @returns {Uint8Array}
     */
    get_proof(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.merkletree_get_proof(retptr, this.__wbg_ptr, index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) MerkleTree.prototype[Symbol.dispose] = MerkleTree.prototype.free;

export class PacketDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PacketDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packetdecoder_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} packet
     * @returns {Uint8Array}
     */
    static extract_data(packet) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetdecoder_extract_data(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} packet
     * @returns {PacketHeader | undefined}
     */
    static parse_header(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetdecoder_parse_header(ptr0, len0);
        return ret === 0 ? undefined : PacketHeader.__wrap(ret);
    }
    constructor() {
        const ret = wasm.filesignaturedetector_new();
        this.__wbg_ptr = ret >>> 0;
        PacketDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} packet
     * @returns {boolean}
     */
    static is_eos(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetdecoder_is_eos(ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} packet
     * @returns {boolean}
     */
    static verify(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetdecoder_verify(ptr0, len0);
        return ret !== 0;
    }
}
if (Symbol.dispose) PacketDecoder.prototype[Symbol.dispose] = PacketDecoder.prototype.free;

export class PacketEncoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PacketEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packetencoder_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get total_bytes_sent() {
        const ret = wasm.packetencoder_total_bytes_sent(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {Uint8Array} data
     * @param {number} file_index
     * @returns {Uint8Array}
     */
    encode_with_file_index(data, file_index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetencoder_encode_with_file_index(retptr, this.__wbg_ptr, ptr0, len0, file_index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    constructor() {
        const ret = wasm.packetencoder_new();
        this.__wbg_ptr = ret >>> 0;
        PacketEncoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    reset() {
        wasm.packetencoder_reset(this.__wbg_ptr);
    }
    /**
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    encode(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetencoder_encode(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get sequence() {
        const ret = wasm.packetencoder_sequence(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) PacketEncoder.prototype[Symbol.dispose] = PacketEncoder.prototype.free;

export class PacketHeader {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PacketHeader.prototype);
        obj.__wbg_ptr = ptr;
        PacketHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PacketHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packetheader_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get file_index() {
        const ret = wasm.__wbg_get_packetheader_file_index(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set file_index(arg0) {
        wasm.__wbg_set_packetheader_file_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get chunk_index() {
        const ret = wasm.__wbg_get_packetheader_chunk_index(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set chunk_index(arg0) {
        wasm.__wbg_set_packetheader_chunk_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {bigint}
     */
    get offset() {
        const ret = wasm.__wbg_get_benchmarkresult_total_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set offset(arg0) {
        wasm.__wbg_set_benchmarkresult_total_bytes(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get length() {
        const ret = wasm.__wbg_get_packetheader_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set length(arg0) {
        wasm.__wbg_set_packetheader_length(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get checksum() {
        const ret = wasm.__wbg_get_packetheader_checksum(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set checksum(arg0) {
        wasm.__wbg_set_packetheader_checksum(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) PacketHeader.prototype[Symbol.dispose] = PacketHeader.prototype.free;

/**
 * 병렬 암호화 세션
 *
 * 대용량 데이터를 청크로 분할하여 병렬로 암호화합니다.
 * AES-GCM은 CTR 모드 기반이므로 각 청크를 독립적으로 암호화할 수 있습니다.
 */
export class ParallelCryptoSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParallelCryptoSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parallelcryptosession_free(ptr, 0);
    }
    /**
     * 청크 크기
     * @returns {number}
     */
    get chunk_size() {
        const ret = wasm.parallelcryptosession_chunk_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 처리된 총 바이트
     * @returns {bigint}
     */
    get total_bytes() {
        const ret = wasm.parallelcryptosession_total_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 데이터를 청크로 분할하여 병렬 암호화
     *
     * WASM 환경에서는 실제 스레드 병렬화가 제한적이므로,
     * 청크별 독립 암호화 구조를 제공하여 Web Worker에서 분산 처리 가능하게 합니다.
     * @param {Uint8Array} plaintext
     * @returns {ParallelEncryptResult}
     */
    encrypt_parallel(plaintext) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.parallelcryptosession_encrypt_parallel(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return ParallelEncryptResult.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 단일 청크 복호화
     * @param {bigint} chunk_index
     * @param {Uint8Array} ciphertext
     * @returns {Uint8Array}
     */
    decrypt_single_chunk(chunk_index, ciphertext) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.parallelcryptosession_decrypt_single_chunk(retptr, this.__wbg_ptr, chunk_index, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 단일 청크 암호화 (Web Worker 분산 처리용)
     *
     * 각 Worker가 독립적으로 청크를 암호화할 수 있습니다.
     * @param {bigint} chunk_index
     * @param {Uint8Array} plaintext
     * @returns {Uint8Array}
     */
    encrypt_single_chunk(chunk_index, plaintext) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.parallelcryptosession_encrypt_single_chunk(retptr, this.__wbg_ptr, chunk_index, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 새 병렬 암호화 세션 생성
     * @param {Uint8Array} master_key
     * @param {number | null} [chunk_size]
     */
    constructor(master_key, chunk_size) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(master_key, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.parallelcryptosession_new(retptr, ptr0, len0, isLikeNone(chunk_size) ? 0x100000001 : (chunk_size) >>> 0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            ParallelCryptoSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) ParallelCryptoSession.prototype[Symbol.dispose] = ParallelCryptoSession.prototype.free;

/**
 * 병렬 복호화 결과
 */
export class ParallelDecryptResult {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParallelDecryptResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_paralleldecryptresult_free(ptr, 0);
    }
    /**
     * 복호화된 평문
     * @returns {Uint8Array}
     */
    get plaintext() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_paralleldecryptresult_plaintext(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 복호화된 평문
     * @param {Uint8Array} arg0
     */
    set plaintext(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_paralleldecryptresult_plaintext(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 성공 여부
     * @returns {boolean}
     */
    get success() {
        const ret = wasm.__wbg_get_paralleldecryptresult_success(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 성공 여부
     * @param {boolean} arg0
     */
    set success(arg0) {
        wasm.__wbg_set_paralleldecryptresult_success(this.__wbg_ptr, arg0);
    }
    /**
     * 실패한 청크 인덱스 (있는 경우)
     * @returns {number | undefined}
     */
    get failed_chunk() {
        const ret = wasm.__wbg_get_paralleldecryptresult_failed_chunk(this.__wbg_ptr);
        return ret === 0x100000001 ? undefined : ret;
    }
    /**
     * 실패한 청크 인덱스 (있는 경우)
     * @param {number | null} [arg0]
     */
    set failed_chunk(arg0) {
        wasm.__wbg_set_paralleldecryptresult_failed_chunk(this.__wbg_ptr, isLikeNone(arg0) ? 0x100000001 : (arg0) >>> 0);
    }
}
if (Symbol.dispose) ParallelDecryptResult.prototype[Symbol.dispose] = ParallelDecryptResult.prototype.free;

/**
 * 병렬 암호화 결과
 */
export class ParallelEncryptResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ParallelEncryptResult.prototype);
        obj.__wbg_ptr = ptr;
        ParallelEncryptResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParallelEncryptResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parallelencryptresult_free(ptr, 0);
    }
    /**
     * 암호화된 청크들 (순서대로)
     * @returns {Uint8Array}
     */
    get chunks() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_parallelencryptresult_chunks(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 암호화된 청크들 (순서대로)
     * @param {Uint8Array} arg0
     */
    set chunks(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_parallelencryptresult_chunks(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 각 청크의 오프셋 (chunks 내에서의 위치)
     * @returns {Uint32Array}
     */
    get offsets() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_parallelencryptresult_offsets(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 각 청크의 오프셋 (chunks 내에서의 위치)
     * @param {Uint32Array} arg0
     */
    set offsets(arg0) {
        const ptr0 = passArray32ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_parallelencryptresult_offsets(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 각 청크의 크기
     * @returns {Uint32Array}
     */
    get sizes() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_parallelencryptresult_sizes(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 각 청크의 크기
     * @param {Uint32Array} arg0
     */
    set sizes(arg0) {
        const ptr0 = passArray32ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_parallelencryptresult_sizes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 총 청크 수
     * @returns {number}
     */
    get chunk_count() {
        const ret = wasm.__wbg_get_parallelencryptresult_chunk_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 총 청크 수
     * @param {number} arg0
     */
    set chunk_count(arg0) {
        wasm.__wbg_set_parallelencryptresult_chunk_count(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) ParallelEncryptResult.prototype[Symbol.dispose] = ParallelEncryptResult.prototype.free;

/**
 * Merkle 증명 노드
 */
export class ProofNode {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProofNodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proofnode_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get hash() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wbg_get_parallelencryptresult_chunks(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} arg0
     */
    set hash(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_parallelencryptresult_chunks(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {boolean}
     */
    get is_left() {
        const ret = wasm.__wbg_get_proofnode_is_left(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {boolean} arg0
     */
    set is_left(arg0) {
        wasm.__wbg_set_proofnode_is_left(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) ProofNode.prototype[Symbol.dispose] = ProofNode.prototype.free;

/**
 * Reed-Solomon 디코더
 */
export class ReedSolomonDecoder {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ReedSolomonDecoder.prototype);
        obj.__wbg_ptr = ptr;
        ReedSolomonDecoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ReedSolomonDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_reedsolomondecoder_free(ptr, 0);
    }
    /**
     * 데이터 복구
     *
     * Returns: 복구된 원본 데이터 (data_shards * shard_size 바이트)
     * @returns {Uint8Array}
     */
    reconstruct() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.reedsolomondecoder_reconstruct(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 샤드 수신
     *
     * Returns: 복구 가능 여부 (data_shards 개 이상 수신 시 true)
     * @param {number} index
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    receive_shard(index, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.reedsolomondecoder_receive_shard(this.__wbg_ptr, index, ptr0, len0);
        return ret !== 0;
    }
    /**
     * 수신된 샤드 수
     * @returns {number}
     */
    received_count() {
        const ret = wasm.reedsolomondecoder_received_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 복구 가능 여부
     * @returns {boolean}
     */
    can_reconstruct() {
        const ret = wasm.reedsolomondecoder_can_reconstruct(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 누락된 샤드 인덱스 목록
     * @returns {Uint32Array}
     */
    missing_indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.reedsolomondecoder_missing_indices(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 새 디코더 생성
     * @param {number} data_shards
     * @param {number} parity_shards
     * @param {number} shard_size
     */
    constructor(data_shards, parity_shards, shard_size) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.reedsolomondecoder_new(retptr, data_shards, parity_shards, shard_size);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            ReedSolomonDecoderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 리셋
     */
    reset() {
        wasm.reedsolomondecoder_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) ReedSolomonDecoder.prototype[Symbol.dispose] = ReedSolomonDecoder.prototype.free;

/**
 * Reed-Solomon 인코더
 */
export class ReedSolomonEncoder {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ReedSolomonEncoder.prototype);
        obj.__wbg_ptr = ptr;
        ReedSolomonEncoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ReedSolomonEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_reedsolomonencoder_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get data_shards() {
        const ret = wasm.chunkpool_chunk_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 단일 블록 인코딩 (편의 메서드)
     *
     * 데이터를 자동으로 패딩하고 샤드로 분할합니다.
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    encode_block(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.reedsolomonencoder_encode_block(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get total_shards() {
        const ret = wasm.reedsolomonencoder_total_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get parity_shards() {
        const ret = wasm.reedsolomonencoder_parity_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 기본 설정으로 인코더 생성 (10 data, 4 parity)
     * @returns {ReedSolomonEncoder}
     */
    static withDefaults() {
        const ret = wasm.reedsolomonencoder_withDefaults();
        return ReedSolomonEncoder.__wrap(ret);
    }
    /**
     * 새 인코더 생성
     * @param {number} data_shards
     * @param {number} parity_shards
     */
    constructor(data_shards, parity_shards) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.reedsolomonencoder_new(retptr, data_shards, parity_shards);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            ReedSolomonEncoderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 데이터에서 패리티 샤드 생성
     *
     * - data: 원본 데이터 (data_shards * shard_size 바이트)
     * - shard_size: 각 샤드의 크기
     *
     * Returns: 패리티 샤드들 (parity_shards * shard_size 바이트)
     * @param {Uint8Array} data
     * @param {number} shard_size
     * @returns {Uint8Array}
     */
    encode(data, shard_size) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.reedsolomonencoder_encode(retptr, this.__wbg_ptr, ptr0, len0, shard_size);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) ReedSolomonEncoder.prototype[Symbol.dispose] = ReedSolomonEncoder.prototype.free;

/**
 * 배치 처리를 위한 슬롯 정보
 */
export class SlotInfo {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SlotInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_slotinfo_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get slot_id() {
        const ret = wasm.__wbg_get_commitresult_slot_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set slot_id(arg0) {
        wasm.__wbg_set_commitresult_slot_id(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get data_ptr() {
        const ret = wasm.__wbg_get_commitresult_packet_ptr(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set data_ptr(arg0) {
        wasm.__wbg_set_commitresult_packet_ptr(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get max_size() {
        const ret = wasm.__wbg_get_commitresult_packet_len(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set max_size(arg0) {
        wasm.__wbg_set_commitresult_packet_len(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) SlotInfo.prototype[Symbol.dispose] = SlotInfo.prototype.free;

/**
 * WASM 기반 Reordering Buffer
 *
 * 비순차적으로 도착하는 청크들을 순서대로 정렬하여 내보내는 버퍼.
 * GC 오버헤드 없이 Arena 기반 메모리 관리로 고속 처리.
 */
export class WasmReorderingBuffer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmReorderingBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmreorderingbuffer_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get pending_count() {
        const ret = wasm.wasmreorderingbuffer_pending_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get buffered_bytes() {
        const ret = wasm.wasmreorderingbuffer_buffered_bytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get total_processed() {
        const ret = wasm.wasmreorderingbuffer_total_processed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get next_expected_offset() {
        const ret = wasm.packetencoder_total_bytes_sent(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 생성자
     * @param {bigint} start_offset
     */
    constructor(start_offset) {
        const ret = wasm.wasmreorderingbuffer_new(start_offset);
        this.__wbg_ptr = ret >>> 0;
        WasmReorderingBufferFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 청크 삽입 및 순차 데이터 반환
     *
     * # Zero-Copy 전략
     * 1. JS에서 WASM 메모리로 직접 복사 (1회)
     * 2. 순차 청크는 즉시 반환 (복사 없음)
     * 3. 비순차 청크는 Arena에 저장
     * @param {Uint8Array} chunk
     * @param {bigint} offset
     * @returns {Uint8Array | undefined}
     */
    push(chunk, offset) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.wasmreorderingbuffer_push(retptr, this.__wbg_ptr, ptr0, len0, offset);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v2;
            if (r0 !== 0) {
                v2 = getArrayU8FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export3(r0, r1 * 1, 1);
            }
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 리소스 정리
     */
    clear() {
        wasm.wasmreorderingbuffer_clear(this.__wbg_ptr);
    }
    /**
     * 시작 오프셋 재설정
     * @param {bigint} start_offset
     */
    reset(start_offset) {
        wasm.wasmreorderingbuffer_reset(this.__wbg_ptr, start_offset);
    }
}
if (Symbol.dispose) WasmReorderingBuffer.prototype[Symbol.dispose] = WasmReorderingBuffer.prototype.free;

/**
 * 배치 처리 지원 Zero-Copy 풀
 *
 * 여러 청크를 한 번에 처리하여 JS ↔ WASM 호출 오버헤드 감소
 */
export class ZeroCopyBatchPool {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ZeroCopyBatchPoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zerocopybatchpool_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    get total_bytes() {
        const ret = wasm.packetencoder_total_bytes_sent(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 여러 슬롯 일괄 커밋
     *
     * - data_lens: 각 슬롯의 데이터 길이 배열
     *
     * Returns: 커밋 결과 배열 (flat: [slot_id, ptr, len, slot_id, ptr, len, ...])
     * @param {Uint32Array} data_lens
     * @returns {Uint32Array}
     */
    commit_batch(data_lens) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray32ToWasm0(data_lens, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.zerocopybatchpool_commit_batch(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 슬롯 반환
     * @param {number} slot_id
     */
    release_slot(slot_id) {
        wasm.zerocopybatchpool_release_slot(this.__wbg_ptr, slot_id);
    }
    /**
     * 여러 슬롯 일괄 획득
     *
     * Returns: 획득한 슬롯 정보 배열 (flat: [slot_id, ptr, size, slot_id, ptr, size, ...])
     * @param {number} count
     * @returns {Int32Array}
     */
    acquire_batch(count) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zerocopybatchpool_acquire_batch(retptr, this.__wbg_ptr, count);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayI32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 여러 슬롯 일괄 반환
     * @param {Uint32Array} slot_ids
     */
    release_batch(slot_ids) {
        const ptr0 = passArray32ToWasm0(slot_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.zerocopybatchpool_release_batch(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 버퍼 포인터
     * @returns {number}
     */
    get_buffer_ptr() {
        const ret = wasm.zerocopybatchpool_get_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 사용 가능한 슬롯 수
     * @returns {number}
     */
    available_slots() {
        const ret = wasm.zerocopybatchpool_available_slots(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.zerocopybatchpool_new();
        this.__wbg_ptr = ret >>> 0;
        ZeroCopyBatchPoolFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 리셋
     */
    reset() {
        wasm.zerocopybatchpool_reset(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get sequence() {
        const ret = wasm.zerocopybatchpool_sequence(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ZeroCopyBatchPool.prototype[Symbol.dispose] = ZeroCopyBatchPool.prototype.free;

/**
 * Zero-Copy 패킷 풀
 *
 * WASM 선형 메모리 내에서 사전 할당된 버퍼를 사용하여
 * JS ↔ WASM 경계에서의 메모리 복사를 최소화합니다.
 *
 * ## 사용 흐름
 * 1. `acquire_slot()` - 쓰기용 슬롯 획득
 * 2. JS에서 WASM 메모리에 직접 데이터 쓰기
 * 3. `commit_slot()` - 헤더 생성 및 CRC 계산
 * 4. `get_packet_view()` - WebRTC 전송용 포인터 획득
 * 5. `release_slot()` - 전송 완료 후 슬롯 반환
 */
export class ZeroCopyPacketPool {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ZeroCopyPacketPool.prototype);
        obj.__wbg_ptr = ptr;
        ZeroCopyPacketPoolFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ZeroCopyPacketPoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zerocopypacketpool_free(ptr, 0);
    }
    /**
     * 일반(평문) 패킷 커밋
     * 🚀 22바이트 헤더를 [16..38] 구간에 작성하여 38부터 시작하는 데이터와 이어지게 함
     * (38 - 22 = 16)
     * @param {number} slot_id
     * @param {number} data_len
     * @returns {number}
     */
    commit_slot(slot_id, data_len) {
        const ret = wasm.zerocopypacketpool_commit_slot(this.__wbg_ptr, slot_id, data_len);
        return ret >>> 0;
    }
    /**
     * 헤더 크기 (바이트)
     * @returns {number}
     */
    header_size() {
        const ret = wasm.zerocopypacketpool_header_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get total_bytes() {
        const ret = wasm.packetencoder_total_bytes_sent(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 전체 슬롯 수
     * @returns {number}
     */
    total_slots() {
        const ret = wasm.zerocopypacketpool_total_slots(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 슬롯 획득 - JS가 데이터를 쓸 위치 반환
     * 🚀 핵심: 항상 MAX_HEADER_SIZE(38) 뒤를 데이터 시작점으로 반환
     * @returns {Int32Array}
     */
    acquire_slot() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zerocopypacketpool_acquire_slot(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayI32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 슬롯 반환
     * @param {number} slot_id
     */
    release_slot(slot_id) {
        wasm.zerocopypacketpool_release_slot(this.__wbg_ptr, slot_id);
    }
    /**
     * 시퀀스 번호 설정 (재개 시 사용)
     * @param {number} seq
     */
    set_sequence(seq) {
        wasm.zerocopypacketpool_set_sequence(this.__wbg_ptr, seq);
    }
    /**
     * 여러 슬롯 일괄 반환
     * @param {Uint32Array} slot_ids
     */
    release_slots(slot_ids) {
        const ptr0 = passArray32ToWasm0(slot_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.zerocopypacketpool_release_slots(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 커스텀 슬롯 수로 풀 생성
     * @param {number} slot_count
     * @returns {ZeroCopyPacketPool}
     */
    static withCapacity(slot_count) {
        const ret = wasm.zerocopypacketpool_withCapacity(slot_count);
        return ZeroCopyPacketPool.__wrap(ret);
    }
    /**
     * 버퍼 전체 길이
     * @returns {number}
     */
    get_buffer_len() {
        const ret = wasm.zerocopypacketpool_get_buffer_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * WASM 메모리 버퍼 포인터 (JS에서 직접 접근용)
     * @returns {number}
     */
    get_buffer_ptr() {
        const ret = wasm.zerocopybatchpool_get_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 사용 가능한 슬롯 수
     * @returns {number}
     */
    available_slots() {
        const ret = wasm.zerocopypacketpool_available_slots(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 커밋된 슬롯 수
     * @returns {number}
     */
    committed_slots() {
        const ret = wasm.zerocopypacketpool_committed_slots(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 패킷 뷰 획득 (WebRTC 전송용)
     * 🚀 저장해둔 오프셋(packet_starts)을 사용하여 올바른 시작 지점 반환
     * @param {number} slot_id
     * @returns {Uint32Array}
     */
    get_packet_view(slot_id) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zerocopypacketpool_get_packet_view(retptr, this.__wbg_ptr, slot_id);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 총 바이트 설정 (재개 시 사용)
     * @param {bigint} bytes
     */
    set_total_bytes(bytes) {
        wasm.zerocopypacketpool_set_total_bytes(this.__wbg_ptr, bytes);
    }
    /**
     * 🚀 [신규] 암호화 패킷 커밋
     * 🚀 38바이트 헤더를 [0..38] 구간에 작성하고 데이터는 In-Place 암호화 수행
     * @param {number} slot_id
     * @param {number} data_len
     * @param {CryptoSession} session
     * @returns {number}
     */
    commit_encrypted_slot(slot_id, data_len, session) {
        _assertClass(session, CryptoSession);
        const ret = wasm.zerocopypacketpool_commit_encrypted_slot(this.__wbg_ptr, slot_id, data_len, session.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 파일 인덱스를 지정하여 슬롯 커밋
     * @param {number} slot_id
     * @param {number} data_len
     * @param {number} file_index
     * @returns {number}
     */
    commit_slot_with_file_index(slot_id, data_len, file_index) {
        const ret = wasm.zerocopypacketpool_commit_slot_with_file_index(this.__wbg_ptr, slot_id, data_len, file_index);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.zerocopypacketpool_new();
        this.__wbg_ptr = ret >>> 0;
        ZeroCopyPacketPoolFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 리셋 - 모든 상태 초기화
     */
    reset() {
        wasm.zerocopypacketpool_reset(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get sequence() {
        const ret = wasm.zerocopybatchpool_sequence(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 슬롯 크기 (바이트)
     * @returns {number}
     */
    slot_size() {
        const ret = wasm.zerocopypacketpool_slot_size(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ZeroCopyPacketPool.prototype[Symbol.dispose] = ZeroCopyPacketPool.prototype.free;

/**
 * ZIP64 스트리밍 압축기
 */
export class Zip64Stream {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Zip64StreamFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zip64stream_free(ptr, 0);
    }
    /**
     * 파일 시작 (Local File Header 생성)
     * @param {string} path
     * @param {bigint} uncompressed_size
     * @returns {Uint8Array}
     */
    begin_file(path, uncompressed_size) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_begin_file(retptr, this.__wbg_ptr, ptr0, len0, uncompressed_size);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 파일 개수
     * @returns {number}
     */
    get file_count() {
        const ret = wasm.zip64stream_file_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 파일 데이터 청크 처리 (압축 또는 STORE)
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    process_chunk(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_compress_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 파일 데이터 청크 압축 (하위 호환성)
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    compress_chunk(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_compress_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 현재까지 입력된 총 바이트 수
     * @returns {bigint}
     */
    get total_input_bytes() {
        const ret = wasm.zip64stream_total_input_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 현재까지 출력된 총 바이트 수
     * @returns {bigint}
     */
    get total_output_bytes() {
        const ret = wasm.zip64stream_total_output_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 현재 파일의 압축된 바이트 수
     * @returns {bigint}
     */
    get current_compressed_bytes() {
        const ret = wasm.zip64stream_current_compressed_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 현재 파일의 원본 바이트 수
     * @returns {bigint}
     */
    get current_uncompressed_bytes() {
        const ret = wasm.zip64stream_current_uncompressed_bytes(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 새 ZIP64 스트림 생성
     * compression_level: 0 = STORE (압축 없음), 1-9 = DEFLATE 압축
     * @param {number} compression_level
     */
    constructor(compression_level) {
        const ret = wasm.zip64stream_new(compression_level);
        this.__wbg_ptr = ret >>> 0;
        Zip64StreamFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 상태 리셋
     */
    reset() {
        wasm.zip64stream_reset(this.__wbg_ptr);
    }
    /**
     * 파일 종료 (Data Descriptor 생성)
     * @returns {Uint8Array}
     */
    end_file() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zip64stream_end_file(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * ZIP 아카이브 종료 (Central Directory + EOCD64 생성)
     * @returns {Uint8Array}
     */
    finalize() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.zip64stream_finalize(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) Zip64Stream.prototype[Symbol.dispose] = Zip64Stream.prototype.free;

/**
 * CRC32 벤치마크
 * @param {number} data_size
 * @param {number} iterations
 * @returns {BenchmarkResult}
 */
export function benchmark_crc32(data_size, iterations) {
    const ret = wasm.benchmark_crc32(data_size, iterations);
    return BenchmarkResult.__wrap(ret);
}

/**
 * 레거시 PacketEncoder 벤치마크
 * @param {number} chunk_size
 * @param {number} iterations
 * @returns {BenchmarkResult}
 */
export function benchmark_legacy_encoder(chunk_size, iterations) {
    const ret = wasm.benchmark_legacy_encoder(chunk_size, iterations);
    return BenchmarkResult.__wrap(ret);
}

/**
 * Zero-Copy 패킷 풀 벤치마크
 * @param {number} chunk_size
 * @param {number} iterations
 * @returns {BenchmarkResult}
 */
export function benchmark_zero_copy_pool(chunk_size, iterations) {
    const ret = wasm.benchmark_zero_copy_pool(chunk_size, iterations);
    return BenchmarkResult.__wrap(ret);
}

/**
 * @param {Uint8Array} data
 * @returns {number}
 */
export function calculate_crc32(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.calculate_crc32(ptr0, len0);
    return ret >>> 0;
}

/**
 * 빠른 Merkle 루트 계산 (청크 배열)
 * @param {Uint8Array} chunks
 * @param {number} chunk_size
 * @returns {Uint8Array}
 */
export function compute_merkle_root(chunks, chunk_size) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(chunks, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.compute_merkle_root(retptr, ptr0, len0, chunk_size);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 키 확인용 HMAC 생성
 * @param {Uint8Array} session_key
 * @returns {Uint8Array}
 */
export function create_key_confirmation(session_key) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.create_key_confirmation(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * HKDF 키 유도 함수
 * @param {Uint8Array} shared_secret
 * @param {Uint8Array} salt
 * @returns {Uint8Array}
 */
export function derive_session_key(shared_secret, salt) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(shared_secret, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(salt, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.derive_session_key(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 빠른 확장자 감지
 * @param {Uint8Array} data
 * @returns {string}
 */
export function detect_extension(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.detect_extension(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 빠른 MIME 타입 감지
 * @param {Uint8Array} data
 * @returns {string}
 */
export function detect_mime_type(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.detect_mime_type(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

export function init() {
    wasm.init();
}

/**
 * 패킷이 암호화된 버전인지 확인
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function is_encrypted_packet(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_encrypted_packet(ptr0, len0);
    return ret !== 0;
}

/**
 * 빠른 압축 (레벨 1)
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function lz4_compress(data) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.lz4_compress(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 빠른 해제
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function lz4_decompress(data) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.lz4_decompress(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 단일 데이터의 SHA-256 해시
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function merkle_hash(data) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.merkle_hash(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 키 확인 검증
 * @param {Uint8Array} session_key
 * @param {Uint8Array} confirmation
 * @returns {boolean}
 */
export function verify_key_confirmation(session_key, confirmation) {
    const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(confirmation, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.verify_key_confirmation(ptr0, len0, ptr1, len1);
    return ret !== 0;
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg___wbindgen_copy_to_typed_array_db832bc4df7216c1 = function(arg0, arg1, arg2) {
        new Uint8Array(getObject(arg2).buffer, getObject(arg2).byteOffset, getObject(arg2).byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
        const ret = debugString(getObject(arg1));
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_now_69d776cd24f5215b = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('pons_core_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
