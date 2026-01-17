//! Bitfield - 피어의 조각 보유 현황을 비트맵으로 표현
//!
//! BitTorrent의 Bitfield와 동일한 개념으로, 각 비트가 하나의 조각(Piece)을 나타냅니다.
//! - 1: 해당 조각 보유
//! - 0: 해당 조각 미보유

use serde::{Deserialize, Serialize};
use std::fmt;

/// 조각 보유 현황 비트맵
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Bitfield {
    bytes: Vec<u8>,
    length: usize, // 총 조각 개수 (비트 수)
}

impl Bitfield {
    /// 새로운 비트필드 생성 (모두 0으로 초기화)
    pub fn new(length: usize) -> Self {
        let byte_len = (length + 7) / 8;
        Self {
            bytes: vec![0u8; byte_len],
            length,
        }
    }

    /// 모든 조각을 보유한 비트필드 생성 (Seeder용)
    pub fn full(length: usize) -> Self {
        let byte_len = (length + 7) / 8;
        let mut bytes = vec![0xFFu8; byte_len];

        // 마지막 바이트의 남는 비트는 0으로 설정
        let remainder = length % 8;
        if remainder > 0 && !bytes.is_empty() {
            let last_idx = bytes.len() - 1;
            bytes[last_idx] = 0xFF << (8 - remainder);
        }

        Self { bytes, length }
    }

    /// 특정 조각 보유 여부 확인
    #[inline]
    pub fn has(&self, index: usize) -> bool {
        if index >= self.length {
            return false;
        }
        let byte_index = index / 8;
        let bit_index = 7 - (index % 8);
        (self.bytes[byte_index] >> bit_index) & 1 == 1
    }

    /// 특정 조각 보유 상태 설정
    #[inline]
    pub fn set(&mut self, index: usize, value: bool) {
        if index >= self.length {
            return;
        }
        let byte_index = index / 8;
        let bit_index = 7 - (index % 8);
        if value {
            self.bytes[byte_index] |= 1 << bit_index;
        } else {
            self.bytes[byte_index] &= !(1 << bit_index);
        }
    }

    /// 조각 보유 표시 (set(index, true)의 단축형)
    #[inline]
    pub fn mark(&mut self, index: usize) {
        self.set(index, true);
    }

    /// 조각 미보유 표시 (set(index, false)의 단축형)
    #[inline]
    pub fn unmark(&mut self, index: usize) {
        self.set(index, false);
    }

    /// 전체 바이트 반환 (네트워크 전송용)
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// 바이트로부터 비트필드 복원
    pub fn from_bytes(bytes: Vec<u8>, length: usize) -> Self {
        let expected_len = (length + 7) / 8;
        assert!(
            bytes.len() >= expected_len,
            "Bitfield bytes too short: expected {}, got {}",
            expected_len,
            bytes.len()
        );
        Self { bytes, length }
    }

    /// 총 조각 개수
    pub fn len(&self) -> usize {
        self.length
    }

    /// 비어있는지 확인
    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    /// 보유한 조각 개수
    pub fn count_ones(&self) -> usize {
        let mut count = 0;
        for i in 0..self.length {
            if self.has(i) {
                count += 1;
            }
        }
        count
    }

    /// 미보유 조각 개수
    pub fn count_zeros(&self) -> usize {
        self.length - self.count_ones()
    }

    /// 완료율 계산 (0.0 ~ 1.0)
    pub fn progress(&self) -> f32 {
        if self.length == 0 {
            return 1.0;
        }
        self.count_ones() as f32 / self.length as f32
    }

    /// 모든 조각을 보유했는지 확인
    pub fn is_complete(&self) -> bool {
        self.count_ones() == self.length
    }

    /// 미보유 조각 인덱스 목록 반환
    pub fn missing_pieces(&self) -> Vec<usize> {
        (0..self.length).filter(|&i| !self.has(i)).collect()
    }

    /// 보유 조각 인덱스 목록 반환
    pub fn available_pieces(&self) -> Vec<usize> {
        (0..self.length).filter(|&i| self.has(i)).collect()
    }

    /// 두 비트필드의 차집합 (other가 가지고 있고 self가 없는 조각)
    pub fn difference(&self, other: &Bitfield) -> Vec<usize> {
        assert_eq!(self.length, other.length, "Bitfield length mismatch");
        (0..self.length)
            .filter(|&i| !self.has(i) && other.has(i))
            .collect()
    }

    /// 두 비트필드의 교집합 (둘 다 가지고 있는 조각)
    pub fn intersection(&self, other: &Bitfield) -> Vec<usize> {
        assert_eq!(self.length, other.length, "Bitfield length mismatch");
        (0..self.length)
            .filter(|&i| self.has(i) && other.has(i))
            .collect()
    }

    /// OR 연산 (다른 비트필드와 합치기)
    pub fn merge(&mut self, other: &Bitfield) {
        assert_eq!(self.length, other.length, "Bitfield length mismatch");
        for (a, b) in self.bytes.iter_mut().zip(other.bytes.iter()) {
            *a |= *b;
        }
    }
}

impl fmt::Debug for Bitfield {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Bitfield {{ length: {}, completed: {}/{}, progress: {:.1}% }}",
            self.length,
            self.count_ones(),
            self.length,
            self.progress() * 100.0
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_bitfield() {
        let bf = Bitfield::new(10);
        assert_eq!(bf.len(), 10);
        assert_eq!(bf.count_ones(), 0);
        assert!(!bf.has(0));
    }

    #[test]
    fn test_set_and_get() {
        let mut bf = Bitfield::new(16);
        bf.set(0, true);
        bf.set(7, true);
        bf.set(15, true);

        assert!(bf.has(0));
        assert!(bf.has(7));
        assert!(bf.has(15));
        assert!(!bf.has(1));
        assert!(!bf.has(8));
    }

    #[test]
    fn test_full_bitfield() {
        let bf = Bitfield::full(10);
        assert_eq!(bf.count_ones(), 10);
        assert!(bf.is_complete());

        for i in 0..10 {
            assert!(bf.has(i));
        }
        assert!(!bf.has(10)); // Out of bounds
    }

    #[test]
    fn test_progress() {
        let mut bf = Bitfield::new(100);
        assert_eq!(bf.progress(), 0.0);

        for i in 0..50 {
            bf.mark(i);
        }
        assert!((bf.progress() - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_serialization() {
        let mut bf = Bitfield::new(16);
        bf.mark(0);
        bf.mark(8);

        let bytes = bf.as_bytes().to_vec();
        let restored = Bitfield::from_bytes(bytes, 16);

        assert!(restored.has(0));
        assert!(restored.has(8));
        assert!(!restored.has(1));
    }

    #[test]
    fn test_difference() {
        let mut bf1 = Bitfield::new(8);
        let mut bf2 = Bitfield::new(8);

        bf1.mark(0);
        bf1.mark(1);
        bf2.mark(1);
        bf2.mark(2);
        bf2.mark(3);

        let diff = bf1.difference(&bf2);
        assert_eq!(diff, vec![2, 3]); // bf2가 가지고 bf1이 없는 것
    }
}
