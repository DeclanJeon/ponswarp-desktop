/* tslint:disable */
/* eslint-disable */

export class AdaptiveFec {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 패킷 손실 보고
   * 
   * - total_sent: 전송한 총 패킷 수
   * - lost: 손실된 패킷 수
   */
  report_loss(total_sent: number, lost: number): void;
  /**
   * 기본 설정 (10 data, 2-6 parity)
   */
  static withDefaults(): AdaptiveFec;
  /**
   * 디코더 생성
   */
  create_decoder(shard_size: number): ReedSolomonDecoder;
  /**
   * 인코더 생성
   */
  create_encoder(): ReedSolomonEncoder;
  constructor(data_shards: number, min_parity: number, max_parity: number);
  /**
   * 리셋
   */
  reset(): void;
  /**
   * 현재 패리티 샤드 수
   */
  readonly current_parity: number;
  /**
   * 현재 오버헤드 비율 (패리티/데이터)
   */
  readonly overhead_ratio: number;
  /**
   * 현재 손실률
   */
  readonly loss_rate: number;
}

export class BenchmarkResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  iterations: number;
  total_bytes: bigint;
  duration_ms: number;
  throughput_mbps: number;
  packets_per_sec: number;
}

export class ChunkPool {
  free(): void;
  [Symbol.dispose](): void;
  preallocate(count: number): void;
  constructor(chunk_size: number, max_pool_size: number);
  clear(): void;
  acquire(): Uint8Array;
  release(buffer: Uint8Array): void;
  readonly chunk_size: number;
  readonly pool_size: number;
}

export class CommitResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  slot_id: number;
  packet_ptr: number;
  packet_len: number;
}

export class Crc32Hasher {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  reset(): void;
  update(data: Uint8Array): void;
  finalize(): number;
}

export class CryptoSession {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 청크 복호화
   */
  decrypt_chunk(packet: Uint8Array): Uint8Array;
  /**
   * 청크 암호화 (패킷 생성 포함)
   */
  encrypt_chunk(plaintext: Uint8Array): Uint8Array;
  /**
   * 🚀 [신규] In-Place 암호화 (Zero-Copy 지원)
   *
   * WASM 메모리 내의 데이터를 직접 암호화하여 불필요한 할당과 복사를 제거합니다.
   * - buffer: 전체 패킷 버퍼 (헤더 공간 포함)
   * - data_offset: 데이터가 시작되는 오프셋
   * - data_len: 데이터 길이
   *
   * Returns: (nonce + tag)가 합쳐진 Vec<u8> 반환 (헤더 작성용)
   */
  encrypt_in_place(buffer: Uint8Array, data_offset: number, data_len: number): Uint8Array;
  /**
   * 세션 키로부터 암호화 컨텍스트 생성
   */
  constructor(session_key: Uint8Array, random_prefix: Uint8Array);
  /**
   * 리셋
   */
  reset(): void;
  /**
   * 총 암호화된 바이트 수
   */
  readonly total_bytes_encrypted: bigint;
  /**
   * 시퀀스 번호
   */
  readonly sequence: number;
}

export class EncryptedPacketHeader {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 바이트에서 헤더 파싱
   */
  static from_bytes(data: Uint8Array): EncryptedPacketHeader | undefined;
  /**
   * 암호화 여부 확인
   */
  is_encrypted(): boolean;
  /**
   * 압축 여부 확인
   */
  is_compressed(): boolean;
  /**
   * 헤더를 바이트로 직렬화
   */
  to_bytes(): Uint8Array;
  version: number;
  flags: number;
  file_index: number;
  chunk_index: number;
  offset: bigint;
  plaintext_length: number;
  nonce: Uint8Array;
}

export class FileSignatureDetector {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  /**
   * 파일 데이터에서 타입 감지
   */
  detect(data: Uint8Array): FileTypeResult;
}

export class FileTypeResult {
  free(): void;
  [Symbol.dispose](): void;
  constructor(mime: string, extension: string, confidence: number);
  mime: string;
  extension: string;
  confidence: number;
}

export class Lz4Compressor {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 데이터 해제
   */
  decompress(input: Uint8Array): Uint8Array;
  constructor(level: number);
  /**
   * 데이터 압축
   */
  compress(input: Uint8Array): Uint8Array;
}

export class MerkleTree {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 증명 검증
   */
  static verify_proof(root: Uint8Array, leaf_data: Uint8Array, _index: number, proof: Uint8Array): boolean;
  /**
   * 데이터 청크들로부터 Merkle Tree 생성
   */
  constructor();
  /**
   * 루트 해시 반환
   */
  root(): Uint8Array;
  /**
   * 리셋
   */
  reset(): void;
  /**
   * 트리 빌드 완료
   */
  finalize(): void;
  /**
   * 청크 추가 (스트리밍 빌드)
   */
  add_chunk(data: Uint8Array): void;
  /**
   * 특정 청크의 증명 경로 생성
   */
  get_proof(index: number): Uint8Array;
  /**
   * 리프 개수
   */
  readonly leaf_count: number;
  /**
   * 트리 높이
   */
  readonly height: number;
}

export class PacketDecoder {
  free(): void;
  [Symbol.dispose](): void;
  static extract_data(packet: Uint8Array): Uint8Array;
  static parse_header(packet: Uint8Array): PacketHeader | undefined;
  constructor();
  static is_eos(packet: Uint8Array): boolean;
  static verify(packet: Uint8Array): boolean;
}

export class PacketEncoder {
  free(): void;
  [Symbol.dispose](): void;
  encode_with_file_index(data: Uint8Array, file_index: number): Uint8Array;
  constructor();
  reset(): void;
  encode(data: Uint8Array): Uint8Array;
  readonly total_bytes_sent: bigint;
  readonly sequence: number;
}

export class PacketHeader {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  file_index: number;
  chunk_index: number;
  offset: bigint;
  length: number;
  checksum: number;
}

export class ParallelCryptoSession {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 데이터를 청크로 분할하여 병렬 암호화
   * 
   * WASM 환경에서는 실제 스레드 병렬화가 제한적이므로,
   * 청크별 독립 암호화 구조를 제공하여 Web Worker에서 분산 처리 가능하게 합니다.
   */
  encrypt_parallel(plaintext: Uint8Array): ParallelEncryptResult;
  /**
   * 단일 청크 복호화
   */
  decrypt_single_chunk(chunk_index: bigint, ciphertext: Uint8Array): Uint8Array;
  /**
   * 단일 청크 암호화 (Web Worker 분산 처리용)
   * 
   * 각 Worker가 독립적으로 청크를 암호화할 수 있습니다.
   */
  encrypt_single_chunk(chunk_index: bigint, plaintext: Uint8Array): Uint8Array;
  /**
   * 새 병렬 암호화 세션 생성
   */
  constructor(master_key: Uint8Array, chunk_size?: number | null);
  /**
   * 청크 크기
   */
  readonly chunk_size: number;
  /**
   * 처리된 총 바이트
   */
  readonly total_bytes: bigint;
}

export class ParallelDecryptResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 복호화된 평문
   */
  plaintext: Uint8Array;
  /**
   * 성공 여부
   */
  success: boolean;
  /**
   * 실패한 청크 인덱스 (있는 경우)
   */
  get failed_chunk(): number | undefined;
  /**
   * 실패한 청크 인덱스 (있는 경우)
   */
  set failed_chunk(value: number | null | undefined);
}

export class ParallelEncryptResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 암호화된 청크들 (순서대로)
   */
  chunks: Uint8Array;
  /**
   * 각 청크의 오프셋 (chunks 내에서의 위치)
   */
  offsets: Uint32Array;
  /**
   * 각 청크의 크기
   */
  sizes: Uint32Array;
  /**
   * 총 청크 수
   */
  chunk_count: number;
}

export class ProofNode {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  hash: Uint8Array;
  is_left: boolean;
}

export class ReedSolomonDecoder {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 데이터 복구
   * 
   * Returns: 복구된 원본 데이터 (data_shards * shard_size 바이트)
   */
  reconstruct(): Uint8Array;
  /**
   * 샤드 수신
   * 
   * Returns: 복구 가능 여부 (data_shards 개 이상 수신 시 true)
   */
  receive_shard(index: number, data: Uint8Array): boolean;
  /**
   * 수신된 샤드 수
   */
  received_count(): number;
  /**
   * 복구 가능 여부
   */
  can_reconstruct(): boolean;
  /**
   * 누락된 샤드 인덱스 목록
   */
  missing_indices(): Uint32Array;
  /**
   * 새 디코더 생성
   */
  constructor(data_shards: number, parity_shards: number, shard_size: number);
  /**
   * 리셋
   */
  reset(): void;
}

export class ReedSolomonEncoder {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 단일 블록 인코딩 (편의 메서드)
   * 
   * 데이터를 자동으로 패딩하고 샤드로 분할합니다.
   */
  encode_block(data: Uint8Array): Uint8Array;
  /**
   * 기본 설정으로 인코더 생성 (10 data, 4 parity)
   */
  static withDefaults(): ReedSolomonEncoder;
  /**
   * 새 인코더 생성
   */
  constructor(data_shards: number, parity_shards: number);
  /**
   * 데이터에서 패리티 샤드 생성
   * 
   * - data: 원본 데이터 (data_shards * shard_size 바이트)
   * - shard_size: 각 샤드의 크기
   * 
   * Returns: 패리티 샤드들 (parity_shards * shard_size 바이트)
   */
  encode(data: Uint8Array, shard_size: number): Uint8Array;
  readonly data_shards: number;
  readonly total_shards: number;
  readonly parity_shards: number;
}

export class SlotInfo {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  slot_id: number;
  data_ptr: number;
  max_size: number;
}

export class WasmReorderingBuffer {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 생성자
   */
  constructor(start_offset: bigint);
  /**
   * 청크 삽입 및 순차 데이터 반환
   * 
   * # Zero-Copy 전략
   * 1. JS에서 WASM 메모리로 직접 복사 (1회)
   * 2. 순차 청크는 즉시 반환 (복사 없음)
   * 3. 비순차 청크는 Arena에 저장
   */
  push(chunk: Uint8Array, offset: bigint): Uint8Array | undefined;
  /**
   * 리소스 정리
   */
  clear(): void;
  /**
   * 시작 오프셋 재설정
   */
  reset(start_offset: bigint): void;
  readonly pending_count: number;
  readonly buffered_bytes: number;
  readonly total_processed: bigint;
  readonly next_expected_offset: bigint;
}

export class ZeroCopyBatchPool {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 여러 슬롯 일괄 커밋
   * 
   * - data_lens: 각 슬롯의 데이터 길이 배열
   * 
   * Returns: 커밋 결과 배열 (flat: [slot_id, ptr, len, slot_id, ptr, len, ...])
   */
  commit_batch(data_lens: Uint32Array): Uint32Array;
  /**
   * 슬롯 반환
   */
  release_slot(slot_id: number): void;
  /**
   * 여러 슬롯 일괄 획득
   * 
   * Returns: 획득한 슬롯 정보 배열 (flat: [slot_id, ptr, size, slot_id, ptr, size, ...])
   */
  acquire_batch(count: number): Int32Array;
  /**
   * 여러 슬롯 일괄 반환
   */
  release_batch(slot_ids: Uint32Array): void;
  /**
   * 버퍼 포인터
   */
  get_buffer_ptr(): number;
  /**
   * 사용 가능한 슬롯 수
   */
  available_slots(): number;
  constructor();
  /**
   * 리셋
   */
  reset(): void;
  readonly total_bytes: bigint;
  readonly sequence: number;
}

export class ZeroCopyPacketPool {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 일반(평문) 패킷 커밋 (호환성 유지)
   * 
   * ⚠️ generation 검증 없이 동작합니다. 새로운 코드에서는 `commit_slot_safe` 사용을 권장합니다.
   * 일반(평문) 패킷 커밋 (호환성 유지)
   * 
   * ⚠️ generation 검증 없이 동작합니다. 새로운 코드에서는 `commit_slot_safe` 사용을 권장합니다.
   * 
   * 🚀 22바이트 헤더를 [16..38] 구간에 작성하여 38부터 시작하는 데이터와 이어지게 함
   * (38 - 22 = 16)
   */
  commit_slot(slot_id: number, data_len: number): number;
  /**
   * 헤더 크기 (바이트)
   */
  header_size(): number;
  /**
   * 전체 슬롯 수
   */
  total_slots(): number;
  /**
   * 슬롯 획득 - JS가 데이터를 쓸 위치 반환
   * 
   * 🚀 핵심: 항상 MAX_HEADER_SIZE(38) 뒤를 데이터 시작점으로 반환
   * 
   * Returns: [slot_id, data_ptr, max_data_size, generation]
   * - slot_id: 슬롯 ID
   * - data_ptr: 데이터를 쓸 WASM 메모리 포인터
   * - max_data_size: 최대 데이터 길이
   * - generation: 이 슬롯의 세대 번호 (commit_slot_safe에서 검증용)
   */
  acquire_slot(): Int32Array;
  /**
   * 슬롯 반환
   */
  release_slot(slot_id: number): void;
  /**
   * 시퀀스 번호 설정 (재개 시 사용)
   */
  set_sequence(seq: number): void;
  /**
   * 여러 슬롯 일괄 반환
   */
  release_slots(slot_ids: Uint32Array): void;
  /**
   * 커스텀 슬롯 수로 풀 생성
   */
  static withCapacity(slot_count: number): ZeroCopyPacketPool;
  /**
   * 버퍼 전체 길이
   */
  get_buffer_len(): number;
  /**
   * WASM 메모리 버퍼 포인터 (JS에서 직접 접근용)
   */
  get_buffer_ptr(): number;
  /**
   * 사용 가능한 슬롯 수
   */
  available_slots(): number;
  /**
   * 커밋된 슬롯 수
   */
  committed_slots(): number;
  /**
   * 패킷 뷰 획득 (WebRTC 전송용)
   * 🚀 저장해둔 오프셋(packet_starts)을 사용하여 올바른 시작 지점 반환
   */
  get_packet_view(slot_id: number): Uint32Array;
  /**
   * 총 바이트 설정 (재개 시 사용)
   */
  set_total_bytes(bytes: bigint): void;
  /**
   * 
   * ## Parameters
   * - `slot_id`: 슬롯 ID
   * - `data_len`: 데이터 길이
   * - `generation`: acquire_slot에서 받은 세대 번호
   * 
   * ## Returns
   * 패킷 총 길이 (헤더 + 데이터). generation 불일치 시 0 반환.
   * 
   * ## 예시
   * ```javascript
   * const [slotId, ptr, maxSize, gen] = pool.acquire_slot();
   * // 데이터 쓰기...
   * const packetLen = pool.commit_slot_safe(slotId, dataLen, gen);
   * if (packetLen === 0) {
   *   // Generation 불일치 - 슬롯이 이미 반환되었거나 재사용됨
   * }
   * ```
   */
  commit_slot_safe(slot_id: number, data_len: number, generation: number): number;
  /**
   * 🚀 [신규] 암호화 패킷 커밋
   * 🚀 38바이트 헤더를 [0..38] 구간에 작성하고 데이터는 In-Place 암호화 수행
   */
  commit_encrypted_slot(slot_id: number, data_len: number, session: CryptoSession): number;
  /**
   * 파일 인덱스를 지정하여 슬롯 커밋 (호환성 유지)
   */
  commit_slot_with_file_index(slot_id: number, data_len: number, file_index: number): number;
  constructor();
  /**
   * 리셋 - 모든 상태 초기화
   */
  reset(): void;
  /**
   * 슬롯 크기 (바이트)
   */
  slot_size(): number;
  readonly total_bytes: bigint;
  readonly sequence: number;
}

export class Zip64Stream {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * 파일 시작 (Local File Header 생성)
   */
  begin_file(path: string, uncompressed_size: bigint): Uint8Array;
  /**
   * 파일 데이터 청크 처리 (압축 또는 STORE)
   */
  process_chunk(data: Uint8Array): Uint8Array;
  /**
   * 새 ZIP64 스트림 생성
   * compression_level: 0 = STORE (압축 없음), 1-9 = DEFLATE 압축
   */
  constructor(compression_level: number);
  /**
   * 상태 리셋
   */
  reset(): void;
  /**
   * 파일 종료 (Data Descriptor 생성)
   */
  end_file(): Uint8Array;
  /**
   * ZIP 아카이브 종료 (Central Directory + EOCD64 생성)
   */
  finalize(): Uint8Array;
  /**
   * 파일 개수
   */
  readonly file_count: number;
  /**
   * 현재까지 입력된 총 바이트 수
   */
  readonly total_input_bytes: bigint;
  /**
   * 현재까지 출력된 총 바이트 수
   */
  readonly total_output_bytes: bigint;
  /**
   * 현재 파일의 압축된 바이트 수
   */
  readonly current_compressed_bytes: bigint;
  /**
   * 현재 파일의 원본 바이트 수
   */
  readonly current_uncompressed_bytes: bigint;
}

/**
 * CRC32 벤치마크
 */
export function benchmark_crc32(data_size: number, iterations: number): BenchmarkResult;

/**
 * 레거시 PacketEncoder 벤치마크
 */
export function benchmark_legacy_encoder(chunk_size: number, iterations: number): BenchmarkResult;

/**
 * Zero-Copy 패킷 풀 벤치마크
 */
export function benchmark_zero_copy_pool(chunk_size: number, iterations: number): BenchmarkResult;

export function calculate_crc32(data: Uint8Array): number;

/**
 * SIMD128 지원 여부 확인
 * 
 * 런타임에 SIMD(Single Instruction Multiple Data) 가속을 지원하는지 확인합니다.
 * SIMD는 대량 데이터 처리(암호화, 해싱, 압축 등)에서 큰 성능 향상을 제공합니다.
 * 
 * ## Returns
 * - `true`: SIMD128 지원 (최고 성능)
 * - `false`: 일반 WASM (호환성 우선)
 * 
 * ## 예시
 * ```javascript
 * if (check_simd_support()) {
 *   console.log('🚀 SIMD128 Enabled - Maximum Performance');
 * } else {
 *   console.log('⚠️ SIMD128 Disabled - Fallback Mode');
 * }
 * ```
 */
export function check_simd_support(): boolean;

/**
 * 빠른 Merkle 루트 계산 (청크 배열)
 */
export function compute_merkle_root(chunks: Uint8Array, chunk_size: number): Uint8Array;

/**
 * 키 확인용 HMAC 생성
 */
export function create_key_confirmation(session_key: Uint8Array): Uint8Array;

/**
 * HKDF 키 유도 함수
 */
export function derive_session_key(shared_secret: Uint8Array, salt: Uint8Array): Uint8Array;

/**
 * 빠른 확장자 감지
 */
export function detect_extension(data: Uint8Array): string;

/**
 * 빠른 MIME 타입 감지
 */
export function detect_mime_type(data: Uint8Array): string;

/**
 * WASM 모듈 초기화
 * 
 * 모든 WASM 기능을 사용하기 전에 먼저 호출해야 합니다.
 */
export function init(): void;

/**
 * 패킷이 암호화된 버전인지 확인
 */
export function is_encrypted_packet(data: Uint8Array): boolean;

/**
 * 빠른 압축 (레벨 1)
 */
export function lz4_compress(data: Uint8Array): Uint8Array;

/**
 * 빠른 해제
 */
export function lz4_decompress(data: Uint8Array): Uint8Array;

/**
 * 단일 데이터의 SHA-256 해시
 */
export function merkle_hash(data: Uint8Array): Uint8Array;

/**
 * 키 확인 검증
 */
export function verify_key_confirmation(session_key: Uint8Array, confirmation: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_adaptivefec_free: (a: number, b: number) => void;
  readonly __wbg_benchmarkresult_free: (a: number, b: number) => void;
  readonly __wbg_chunkpool_free: (a: number, b: number) => void;
  readonly __wbg_commitresult_free: (a: number, b: number) => void;
  readonly __wbg_crc32hasher_free: (a: number, b: number) => void;
  readonly __wbg_cryptosession_free: (a: number, b: number) => void;
  readonly __wbg_encryptedpacketheader_free: (a: number, b: number) => void;
  readonly __wbg_filesignaturedetector_free: (a: number, b: number) => void;
  readonly __wbg_filetyperesult_free: (a: number, b: number) => void;
  readonly __wbg_get_benchmarkresult_duration_ms: (a: number) => number;
  readonly __wbg_get_benchmarkresult_iterations: (a: number) => number;
  readonly __wbg_get_benchmarkresult_packets_per_sec: (a: number) => number;
  readonly __wbg_get_benchmarkresult_throughput_mbps: (a: number) => number;
  readonly __wbg_get_benchmarkresult_total_bytes: (a: number) => bigint;
  readonly __wbg_get_commitresult_packet_len: (a: number) => number;
  readonly __wbg_get_commitresult_packet_ptr: (a: number) => number;
  readonly __wbg_get_commitresult_slot_id: (a: number) => number;
  readonly __wbg_get_encryptedpacketheader_chunk_index: (a: number) => number;
  readonly __wbg_get_encryptedpacketheader_file_index: (a: number) => number;
  readonly __wbg_get_encryptedpacketheader_flags: (a: number) => number;
  readonly __wbg_get_encryptedpacketheader_nonce: (a: number, b: number) => void;
  readonly __wbg_get_encryptedpacketheader_plaintext_length: (a: number) => number;
  readonly __wbg_get_encryptedpacketheader_version: (a: number) => number;
  readonly __wbg_get_filetyperesult_confidence: (a: number) => number;
  readonly __wbg_get_filetyperesult_extension: (a: number, b: number) => void;
  readonly __wbg_get_filetyperesult_mime: (a: number, b: number) => void;
  readonly __wbg_get_packetheader_checksum: (a: number) => number;
  readonly __wbg_get_packetheader_chunk_index: (a: number) => number;
  readonly __wbg_get_packetheader_file_index: (a: number) => number;
  readonly __wbg_get_packetheader_length: (a: number) => number;
  readonly __wbg_get_paralleldecryptresult_failed_chunk: (a: number) => number;
  readonly __wbg_get_paralleldecryptresult_plaintext: (a: number, b: number) => void;
  readonly __wbg_get_paralleldecryptresult_success: (a: number) => number;
  readonly __wbg_get_parallelencryptresult_chunk_count: (a: number) => number;
  readonly __wbg_get_parallelencryptresult_chunks: (a: number, b: number) => void;
  readonly __wbg_get_parallelencryptresult_offsets: (a: number, b: number) => void;
  readonly __wbg_get_parallelencryptresult_sizes: (a: number, b: number) => void;
  readonly __wbg_get_proofnode_is_left: (a: number) => number;
  readonly __wbg_merkletree_free: (a: number, b: number) => void;
  readonly __wbg_packetencoder_free: (a: number, b: number) => void;
  readonly __wbg_packetheader_free: (a: number, b: number) => void;
  readonly __wbg_parallelcryptosession_free: (a: number, b: number) => void;
  readonly __wbg_paralleldecryptresult_free: (a: number, b: number) => void;
  readonly __wbg_parallelencryptresult_free: (a: number, b: number) => void;
  readonly __wbg_proofnode_free: (a: number, b: number) => void;
  readonly __wbg_reedsolomondecoder_free: (a: number, b: number) => void;
  readonly __wbg_reedsolomonencoder_free: (a: number, b: number) => void;
  readonly __wbg_set_benchmarkresult_duration_ms: (a: number, b: number) => void;
  readonly __wbg_set_benchmarkresult_iterations: (a: number, b: number) => void;
  readonly __wbg_set_benchmarkresult_packets_per_sec: (a: number, b: number) => void;
  readonly __wbg_set_benchmarkresult_throughput_mbps: (a: number, b: number) => void;
  readonly __wbg_set_benchmarkresult_total_bytes: (a: number, b: bigint) => void;
  readonly __wbg_set_commitresult_packet_len: (a: number, b: number) => void;
  readonly __wbg_set_commitresult_packet_ptr: (a: number, b: number) => void;
  readonly __wbg_set_commitresult_slot_id: (a: number, b: number) => void;
  readonly __wbg_set_encryptedpacketheader_chunk_index: (a: number, b: number) => void;
  readonly __wbg_set_encryptedpacketheader_file_index: (a: number, b: number) => void;
  readonly __wbg_set_encryptedpacketheader_flags: (a: number, b: number) => void;
  readonly __wbg_set_encryptedpacketheader_nonce: (a: number, b: number, c: number) => void;
  readonly __wbg_set_encryptedpacketheader_plaintext_length: (a: number, b: number) => void;
  readonly __wbg_set_encryptedpacketheader_version: (a: number, b: number) => void;
  readonly __wbg_set_filetyperesult_confidence: (a: number, b: number) => void;
  readonly __wbg_set_filetyperesult_extension: (a: number, b: number, c: number) => void;
  readonly __wbg_set_filetyperesult_mime: (a: number, b: number, c: number) => void;
  readonly __wbg_set_packetheader_checksum: (a: number, b: number) => void;
  readonly __wbg_set_packetheader_chunk_index: (a: number, b: number) => void;
  readonly __wbg_set_packetheader_file_index: (a: number, b: number) => void;
  readonly __wbg_set_packetheader_length: (a: number, b: number) => void;
  readonly __wbg_set_paralleldecryptresult_failed_chunk: (a: number, b: number) => void;
  readonly __wbg_set_paralleldecryptresult_plaintext: (a: number, b: number, c: number) => void;
  readonly __wbg_set_paralleldecryptresult_success: (a: number, b: number) => void;
  readonly __wbg_set_parallelencryptresult_chunk_count: (a: number, b: number) => void;
  readonly __wbg_set_parallelencryptresult_chunks: (a: number, b: number, c: number) => void;
  readonly __wbg_set_parallelencryptresult_offsets: (a: number, b: number, c: number) => void;
  readonly __wbg_set_parallelencryptresult_sizes: (a: number, b: number, c: number) => void;
  readonly __wbg_set_proofnode_is_left: (a: number, b: number) => void;
  readonly __wbg_wasmreorderingbuffer_free: (a: number, b: number) => void;
  readonly __wbg_zerocopybatchpool_free: (a: number, b: number) => void;
  readonly __wbg_zerocopypacketpool_free: (a: number, b: number) => void;
  readonly __wbg_zip64stream_free: (a: number, b: number) => void;
  readonly adaptivefec_create_decoder: (a: number, b: number, c: number) => void;
  readonly adaptivefec_create_encoder: (a: number, b: number) => void;
  readonly adaptivefec_current_parity: (a: number) => number;
  readonly adaptivefec_loss_rate: (a: number) => number;
  readonly adaptivefec_new: (a: number, b: number, c: number) => number;
  readonly adaptivefec_overhead_ratio: (a: number) => number;
  readonly adaptivefec_report_loss: (a: number, b: number, c: number) => void;
  readonly adaptivefec_reset: (a: number) => void;
  readonly adaptivefec_withDefaults: () => number;
  readonly benchmark_crc32: (a: number, b: number) => number;
  readonly benchmark_legacy_encoder: (a: number, b: number) => number;
  readonly benchmark_zero_copy_pool: (a: number, b: number) => number;
  readonly calculate_crc32: (a: number, b: number) => number;
  readonly check_simd_support: () => number;
  readonly chunkpool_acquire: (a: number, b: number) => void;
  readonly chunkpool_chunk_size: (a: number) => number;
  readonly chunkpool_clear: (a: number) => void;
  readonly chunkpool_new: (a: number, b: number) => number;
  readonly chunkpool_pool_size: (a: number) => number;
  readonly chunkpool_preallocate: (a: number, b: number) => void;
  readonly chunkpool_release: (a: number, b: number, c: number) => void;
  readonly compute_merkle_root: (a: number, b: number, c: number, d: number) => void;
  readonly crc32hasher_finalize: (a: number) => number;
  readonly crc32hasher_new: () => number;
  readonly crc32hasher_reset: (a: number) => void;
  readonly crc32hasher_update: (a: number, b: number, c: number) => void;
  readonly create_key_confirmation: (a: number, b: number, c: number) => void;
  readonly cryptosession_decrypt_chunk: (a: number, b: number, c: number, d: number) => void;
  readonly cryptosession_encrypt_chunk: (a: number, b: number, c: number, d: number) => void;
  readonly cryptosession_encrypt_in_place: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly cryptosession_new: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly cryptosession_reset: (a: number) => void;
  readonly cryptosession_sequence: (a: number) => number;
  readonly cryptosession_total_bytes_encrypted: (a: number) => bigint;
  readonly derive_session_key: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly detect_extension: (a: number, b: number, c: number) => void;
  readonly detect_mime_type: (a: number, b: number, c: number) => void;
  readonly encryptedpacketheader_from_bytes: (a: number, b: number) => number;
  readonly encryptedpacketheader_is_compressed: (a: number) => number;
  readonly encryptedpacketheader_is_encrypted: (a: number) => number;
  readonly encryptedpacketheader_to_bytes: (a: number, b: number) => void;
  readonly filesignaturedetector_detect: (a: number, b: number, c: number) => number;
  readonly filetyperesult_new: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly init: () => void;
  readonly is_encrypted_packet: (a: number, b: number) => number;
  readonly lz4_compress: (a: number, b: number, c: number) => void;
  readonly lz4_decompress: (a: number, b: number, c: number) => void;
  readonly lz4compressor_compress: (a: number, b: number, c: number, d: number) => void;
  readonly lz4compressor_decompress: (a: number, b: number, c: number, d: number) => void;
  readonly lz4compressor_new: (a: number) => number;
  readonly merkle_hash: (a: number, b: number, c: number) => void;
  readonly merkletree_add_chunk: (a: number, b: number, c: number) => void;
  readonly merkletree_finalize: (a: number) => void;
  readonly merkletree_get_proof: (a: number, b: number, c: number) => void;
  readonly merkletree_height: (a: number) => number;
  readonly merkletree_leaf_count: (a: number) => number;
  readonly merkletree_new: () => number;
  readonly merkletree_reset: (a: number) => void;
  readonly merkletree_root: (a: number, b: number) => void;
  readonly merkletree_verify_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  readonly packetdecoder_extract_data: (a: number, b: number, c: number) => void;
  readonly packetdecoder_is_eos: (a: number, b: number) => number;
  readonly packetdecoder_parse_header: (a: number, b: number) => number;
  readonly packetdecoder_verify: (a: number, b: number) => number;
  readonly packetencoder_encode: (a: number, b: number, c: number, d: number) => void;
  readonly packetencoder_encode_with_file_index: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly packetencoder_new: () => number;
  readonly packetencoder_reset: (a: number) => void;
  readonly packetencoder_sequence: (a: number) => number;
  readonly packetencoder_total_bytes_sent: (a: number) => bigint;
  readonly parallelcryptosession_chunk_size: (a: number) => number;
  readonly parallelcryptosession_decrypt_single_chunk: (a: number, b: number, c: bigint, d: number, e: number) => void;
  readonly parallelcryptosession_encrypt_parallel: (a: number, b: number, c: number, d: number) => void;
  readonly parallelcryptosession_encrypt_single_chunk: (a: number, b: number, c: bigint, d: number, e: number) => void;
  readonly parallelcryptosession_new: (a: number, b: number, c: number, d: number) => void;
  readonly parallelcryptosession_total_bytes: (a: number) => bigint;
  readonly reedsolomondecoder_can_reconstruct: (a: number) => number;
  readonly reedsolomondecoder_missing_indices: (a: number, b: number) => void;
  readonly reedsolomondecoder_new: (a: number, b: number, c: number, d: number) => void;
  readonly reedsolomondecoder_receive_shard: (a: number, b: number, c: number, d: number) => number;
  readonly reedsolomondecoder_received_count: (a: number) => number;
  readonly reedsolomondecoder_reconstruct: (a: number, b: number) => void;
  readonly reedsolomondecoder_reset: (a: number) => void;
  readonly reedsolomonencoder_encode: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly reedsolomonencoder_encode_block: (a: number, b: number, c: number, d: number) => void;
  readonly reedsolomonencoder_new: (a: number, b: number, c: number) => void;
  readonly reedsolomonencoder_parity_shards: (a: number) => number;
  readonly reedsolomonencoder_total_shards: (a: number) => number;
  readonly reedsolomonencoder_withDefaults: () => number;
  readonly verify_key_confirmation: (a: number, b: number, c: number, d: number) => number;
  readonly wasmreorderingbuffer_buffered_bytes: (a: number) => number;
  readonly wasmreorderingbuffer_clear: (a: number) => void;
  readonly wasmreorderingbuffer_new: (a: bigint) => number;
  readonly wasmreorderingbuffer_pending_count: (a: number) => number;
  readonly wasmreorderingbuffer_push: (a: number, b: number, c: number, d: number, e: bigint) => void;
  readonly wasmreorderingbuffer_reset: (a: number, b: bigint) => void;
  readonly wasmreorderingbuffer_total_processed: (a: number) => bigint;
  readonly zerocopybatchpool_acquire_batch: (a: number, b: number, c: number) => void;
  readonly zerocopybatchpool_available_slots: (a: number) => number;
  readonly zerocopybatchpool_commit_batch: (a: number, b: number, c: number, d: number) => void;
  readonly zerocopybatchpool_get_buffer_ptr: (a: number) => number;
  readonly zerocopybatchpool_new: () => number;
  readonly zerocopybatchpool_release_batch: (a: number, b: number, c: number) => void;
  readonly zerocopybatchpool_release_slot: (a: number, b: number) => void;
  readonly zerocopybatchpool_reset: (a: number) => void;
  readonly zerocopybatchpool_sequence: (a: number) => number;
  readonly zerocopypacketpool_acquire_slot: (a: number, b: number) => void;
  readonly zerocopypacketpool_available_slots: (a: number) => number;
  readonly zerocopypacketpool_commit_encrypted_slot: (a: number, b: number, c: number, d: number) => number;
  readonly zerocopypacketpool_commit_slot: (a: number, b: number, c: number) => number;
  readonly zerocopypacketpool_commit_slot_safe: (a: number, b: number, c: number, d: number) => number;
  readonly zerocopypacketpool_commit_slot_with_file_index: (a: number, b: number, c: number, d: number) => number;
  readonly zerocopypacketpool_committed_slots: (a: number) => number;
  readonly zerocopypacketpool_get_buffer_len: (a: number) => number;
  readonly zerocopypacketpool_get_packet_view: (a: number, b: number, c: number) => void;
  readonly zerocopypacketpool_header_size: (a: number) => number;
  readonly zerocopypacketpool_new: () => number;
  readonly zerocopypacketpool_release_slot: (a: number, b: number) => void;
  readonly zerocopypacketpool_release_slots: (a: number, b: number, c: number) => void;
  readonly zerocopypacketpool_reset: (a: number) => void;
  readonly zerocopypacketpool_set_sequence: (a: number, b: number) => void;
  readonly zerocopypacketpool_set_total_bytes: (a: number, b: bigint) => void;
  readonly zerocopypacketpool_slot_size: (a: number) => number;
  readonly zerocopypacketpool_total_slots: (a: number) => number;
  readonly zerocopypacketpool_withCapacity: (a: number) => number;
  readonly zip64stream_begin_file: (a: number, b: number, c: number, d: number, e: bigint) => void;
  readonly zip64stream_current_compressed_bytes: (a: number) => bigint;
  readonly zip64stream_current_uncompressed_bytes: (a: number) => bigint;
  readonly zip64stream_end_file: (a: number, b: number) => void;
  readonly zip64stream_file_count: (a: number) => number;
  readonly zip64stream_finalize: (a: number, b: number) => void;
  readonly zip64stream_new: (a: number) => number;
  readonly zip64stream_process_chunk: (a: number, b: number, c: number, d: number) => void;
  readonly zip64stream_reset: (a: number) => void;
  readonly zip64stream_total_input_bytes: (a: number) => bigint;
  readonly zip64stream_total_output_bytes: (a: number) => bigint;
  readonly __wbg_set_encryptedpacketheader_offset: (a: number, b: bigint) => void;
  readonly __wbg_set_packetheader_offset: (a: number, b: bigint) => void;
  readonly __wbg_set_slotinfo_data_ptr: (a: number, b: number) => void;
  readonly __wbg_set_slotinfo_max_size: (a: number, b: number) => void;
  readonly __wbg_set_slotinfo_slot_id: (a: number, b: number) => void;
  readonly __wbg_set_proofnode_hash: (a: number, b: number, c: number) => void;
  readonly zerocopypacketpool_get_buffer_ptr: (a: number) => number;
  readonly __wbg_get_proofnode_hash: (a: number, b: number) => void;
  readonly __wbg_get_encryptedpacketheader_offset: (a: number) => bigint;
  readonly __wbg_get_packetheader_offset: (a: number) => bigint;
  readonly __wbg_get_slotinfo_data_ptr: (a: number) => number;
  readonly __wbg_get_slotinfo_max_size: (a: number) => number;
  readonly __wbg_get_slotinfo_slot_id: (a: number) => number;
  readonly reedsolomonencoder_data_shards: (a: number) => number;
  readonly wasmreorderingbuffer_next_expected_offset: (a: number) => bigint;
  readonly zerocopybatchpool_total_bytes: (a: number) => bigint;
  readonly zerocopypacketpool_sequence: (a: number) => number;
  readonly zerocopypacketpool_total_bytes: (a: number) => bigint;
  readonly __wbg_lz4compressor_free: (a: number, b: number) => void;
  readonly __wbg_packetdecoder_free: (a: number, b: number) => void;
  readonly __wbg_slotinfo_free: (a: number, b: number) => void;
  readonly filesignaturedetector_new: () => number;
  readonly packetdecoder_new: () => number;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
