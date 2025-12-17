let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}

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

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(takeObject(mem.getUint32(i, true)));
    }
    return result;
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

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
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

const ChunkPoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_chunkpool_free(ptr >>> 0, 1));

const Crc32HasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_crc32hasher_free(ptr >>> 0, 1));

const CryptoSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cryptosession_free(ptr >>> 0, 1));

const EncryptedPacketHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedpacketheader_free(ptr >>> 0, 1));

const FecConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fecconfig_free(ptr >>> 0, 1));

const FecDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fecdecoder_free(ptr >>> 0, 1));

const FecEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fecencoder_free(ptr >>> 0, 1));

const PacketDecoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetdecoder_free(ptr >>> 0, 1));

const PacketEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetencoder_free(ptr >>> 0, 1));

const PacketHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packetheader_free(ptr >>> 0, 1));

const WasmReorderingBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmreorderingbuffer_free(ptr >>> 0, 1));

const Zip64StreamFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zip64stream_free(ptr >>> 0, 1));

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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} buffer
     */
    release(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_export2);
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
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
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
            const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export2);
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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.cryptosession_encrypt_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(random_prefix, wasm.__wbindgen_export2);
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
        const ret = wasm.__wbg_get_encryptedpacketheader_offset(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set offset(arg0) {
        wasm.__wbg_set_encryptedpacketheader_offset(this.__wbg_ptr, arg0);
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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {Uint8Array} arg0
     */
    set nonce(arg0) {
        const ptr0 = passArray8ToWasm0(arg0, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.__wbg_set_encryptedpacketheader_nonce(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * 바이트에서 헤더 파싱
     * @param {Uint8Array} data
     * @returns {EncryptedPacketHeader | undefined}
     */
    static from_bytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) EncryptedPacketHeader.prototype[Symbol.dispose] = EncryptedPacketHeader.prototype.free;

/**
 * FEC 인코딩/디코딩 설정
 */
export class FecConfig {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(FecConfig.prototype);
        obj.__wbg_ptr = ptr;
        FecConfigFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FecConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fecconfig_free(ptr, 0);
    }
    /**
     * 데이터 샤드 수 (K)
     * @returns {number}
     */
    get data_shards() {
        const ret = wasm.__wbg_get_fecconfig_data_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 데이터 샤드 수 (K)
     * @param {number} arg0
     */
    set data_shards(arg0) {
        wasm.__wbg_set_fecconfig_data_shards(this.__wbg_ptr, arg0);
    }
    /**
     * 패리티 샤드 수 (M)
     * @returns {number}
     */
    get parity_shards() {
        const ret = wasm.__wbg_get_fecconfig_parity_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 패리티 샤드 수 (M)
     * @param {number} arg0
     */
    set parity_shards(arg0) {
        wasm.__wbg_set_fecconfig_parity_shards(this.__wbg_ptr, arg0);
    }
    /**
     * 샤드 크기 (bytes)
     * @returns {number}
     */
    get shard_size() {
        const ret = wasm.__wbg_get_fecconfig_shard_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 샤드 크기 (bytes)
     * @param {number} arg0
     */
    set shard_size(arg0) {
        wasm.__wbg_set_fecconfig_shard_size(this.__wbg_ptr, arg0);
    }
    /**
     * 총 샤드 수 (K + M)
     * @returns {number}
     */
    get total_shards() {
        const ret = wasm.fecconfig_total_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 네트워크 손실률에 따른 프리셋 생성
     * - loss < 1%: minimal (K=16, M=2)
     * - loss < 5%: balanced (K=8, M=2)
     * - loss >= 5%: aggressive (K=4, M=2)
     * @param {number} loss_percent
     * @param {number} shard_size
     * @returns {FecConfig}
     */
    static from_loss_rate(loss_percent, shard_size) {
        const ret = wasm.fecconfig_from_loss_rate(loss_percent, shard_size);
        return FecConfig.__wrap(ret);
    }
    /**
     * 오버헤드 비율 (M / K)
     * @returns {number}
     */
    get overhead_ratio() {
        const ret = wasm.fecconfig_overhead_ratio(this.__wbg_ptr);
        return ret;
    }
    /**
     * 새 FEC 설정 생성
     * @param {number} data_shards
     * @param {number} parity_shards
     * @param {number} shard_size
     */
    constructor(data_shards, parity_shards, shard_size) {
        const ret = wasm.fecconfig_new(data_shards, parity_shards, shard_size);
        this.__wbg_ptr = ret >>> 0;
        FecConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) FecConfig.prototype[Symbol.dispose] = FecConfig.prototype.free;

/**
 * FEC 디코더 - 손실된 샤드 복구
 */
export class FecDecoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FecDecoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fecdecoder_free(ptr, 0);
    }
    /**
     * 샤드 수신 처리
     * 반환: 복구 완료된 데이터 샤드들 (순서대로)
     * @param {number} block_index
     * @param {number} shard_index
     * @param {number} shard_count
     * @param {Uint8Array} data
     * @returns {Uint8Array[] | undefined}
     */
    receive_shard(block_index, shard_index, shard_count, data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.fecdecoder_receive_shard(retptr, this.__wbg_ptr, block_index, shard_index, shard_count, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v2;
            if (r0 !== 0) {
                v2 = getArrayJsValueFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 4, 4);
            }
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get recovery_rate() {
        const ret = wasm.fecdecoder_recovery_rate(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get total_received() {
        const ret = wasm.fecdecoder_total_received(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get total_recovered() {
        const ret = wasm.fecdecoder_total_recovered(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 특정 블록 강제 디코딩 시도 (타임아웃 시)
     * @param {number} block_index
     * @returns {Uint8Array[] | undefined}
     */
    force_decode_block(block_index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.fecdecoder_force_decode_block(retptr, this.__wbg_ptr, block_index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayJsValueFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 4, 4);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get pending_block_count() {
        const ret = wasm.fecdecoder_pending_block_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 타임아웃된 블록 정리 (메모리 보호)
     * @param {number} timeout_ms
     * @returns {number}
     */
    cleanup_stale_blocks(timeout_ms) {
        const ret = wasm.fecdecoder_cleanup_stale_blocks(this.__wbg_ptr, timeout_ms);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get total_blocks_decoded() {
        const ret = wasm.fecdecoder_total_blocks_decoded(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * 새 FEC 디코더 생성
     * @param {FecConfig} config
     */
    constructor(config) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(config, FecConfig);
            wasm.fecdecoder_new(retptr, config.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            FecDecoderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 디코더 리셋
     */
    reset() {
        wasm.fecdecoder_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) FecDecoder.prototype[Symbol.dispose] = FecDecoder.prototype.free;

/**
 * FEC 인코더 - 데이터 청크를 FEC 블록으로 변환
 */
export class FecEncoder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FecEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fecencoder_free(ptr, 0);
    }
    /**
     * 데이터 샤드 수
     * @returns {number}
     */
    get data_shards() {
        const ret = wasm.fecencoder_data_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 패리티 샤드 수
     * @returns {number}
     */
    get parity_shards() {
        const ret = wasm.fecencoder_parity_shards(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 버퍼에 있는 청크 수
     * @returns {number}
     */
    get buffered_count() {
        const ret = wasm.fecencoder_buffered_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 현재 블록 인덱스
     * @returns {number}
     */
    get current_block_index() {
        const ret = wasm.fecdecoder_pending_block_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 새 FEC 인코더 생성
     * @param {FecConfig} config
     */
    constructor(config) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(config, FecConfig);
            wasm.fecencoder_new(retptr, config.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            FecEncoderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 남은 버퍼 강제 플러시 (전송 종료 시)
     * @returns {Uint8Array[] | undefined}
     */
    flush() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.fecencoder_flush(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayJsValueFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 4, 4);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 인코더 리셋
     */
    reset() {
        wasm.fecencoder_reset(this.__wbg_ptr);
    }
    /**
     * 청크 추가 - 블록이 완성되면 인코딩된 샤드 배열 반환
     * @param {Uint8Array} data
     * @returns {Uint8Array[] | undefined}
     */
    add_chunk(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.fecencoder_add_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v2;
            if (r0 !== 0) {
                v2 = getArrayJsValueFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 4, 4);
            }
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) FecEncoder.prototype[Symbol.dispose] = FecEncoder.prototype.free;

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
            const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetdecoder_extract_data(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetdecoder_parse_header(ptr0, len0);
        return ret === 0 ? undefined : PacketHeader.__wrap(ret);
    }
    constructor() {
        const ret = wasm.packetdecoder_new();
        this.__wbg_ptr = ret >>> 0;
        PacketDecoderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} packet
     * @returns {boolean}
     */
    static is_eos(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packetdecoder_is_eos(ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} packet
     * @returns {boolean}
     */
    static verify(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_export2);
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
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetencoder_encode_with_file_index(retptr, this.__wbg_ptr, ptr0, len0, file_index);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.packetencoder_encode(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
        const ret = wasm.__wbg_get_encryptedpacketheader_offset(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set offset(arg0) {
        wasm.__wbg_set_encryptedpacketheader_offset(this.__wbg_ptr, arg0);
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
            const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.wasmreorderingbuffer_push(retptr, this.__wbg_ptr, ptr0, len0, offset);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v2;
            if (r0 !== 0) {
                v2 = getArrayU8FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_begin_file(retptr, this.__wbg_ptr, ptr0, len0, uncompressed_size);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_compress_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.zip64stream_compress_chunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) Zip64Stream.prototype[Symbol.dispose] = Zip64Stream.prototype.free;

/**
 * @param {Uint8Array} data
 * @returns {number}
 */
export function calculate_crc32(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.calculate_crc32(ptr0, len0);
    return ret >>> 0;
}

/**
 * 키 확인용 HMAC 생성
 * @param {Uint8Array} session_key
 * @returns {Uint8Array}
 */
export function create_key_confirmation(session_key) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.create_key_confirmation(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 1, 1);
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
        const ptr0 = passArray8ToWasm0(shared_secret, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(salt, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        wasm.derive_session_key(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
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
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_encrypted_packet(ptr0, len0);
    return ret !== 0;
}

/**
 * 키 확인 검증
 * @param {Uint8Array} session_key
 * @param {Uint8Array} confirmation
 * @returns {boolean}
 */
export function verify_key_confirmation(session_key, confirmation) {
    const ptr0 = passArray8ToWasm0(session_key, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(confirmation, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.verify_key_confirmation(ptr0, len0, ptr1, len1);
    return ret !== 0;
}

export function __wbg___wbindgen_throw_dd24417ed36fc46e(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

export function __wbg_length_22ac23eaec9d8053(arg0) {
    const ret = getObject(arg0).length;
    return ret;
};

export function __wbg_new_with_length_aa5eaf41d35235e5(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return addHeapObject(ret);
};

export function __wbg_now_69d776cd24f5215b() {
    const ret = Date.now();
    return ret;
};

export function __wbg_set_169e13b608078b7b(arg0, arg1, arg2) {
    getObject(arg0).set(getArrayU8FromWasm0(arg1, arg2));
};

export function __wbindgen_cast_2241b6af4c4b2941(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
};
