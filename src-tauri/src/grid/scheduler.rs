//! Rare-First Scheduler - 희귀 조각 우선 스케줄링 알고리즘
//!
//! BitTorrent의 Rare-First 전략을 구현하여 네트워크 전체의 데이터 가용성을 극대화합니다.
//!
//! ## 전략
//! - **Random First**: 초기에는 아무 조각이나 빨리 받아 "줄 것이 있는" 상태 확보
//! - **Rare First**: 복제본이 가장 적은 조각부터 요청
//! - **Endgame**: 마지막 몇 조각은 모든 피어에게 동시 요청

use rand::seq::SliceRandom;
use rand::thread_rng;
use std::collections::{HashMap, HashSet};
use tracing::debug;

/// 피어 ID 타입
pub type PeerId = String;

/// 스케줄링 모드
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleMode {
    /// 초기 단계: 아무거나 빨리 받기
    RandomFirst,
    /// 중간 단계: 희귀 조각 우선
    RareFirst,
    /// 마지막 단계: 모든 피어에게 동시 요청
    Endgame,
}

/// 조각 요청 정보
#[derive(Debug, Clone)]
pub struct PieceRequest {
    pub piece_index: usize,
    pub target_peer: PeerId,
    pub priority: u32,
}

/// Rare-First 스케줄러
pub struct Scheduler {
    total_pieces: usize,
    /// 각 조각별 보유 피어 수 (Frequency Map)
    piece_frequency: Vec<usize>,
    /// 내가 이미 가지고 있는 조각
    my_pieces: HashSet<usize>,
    /// 현재 다운로드 중인 조각
    pending_pieces: HashSet<usize>,
    /// 각 피어가 가진 조각 (PeerId -> piece indices)
    peer_pieces: HashMap<PeerId, HashSet<usize>>,
    /// 현재 스케줄링 모드
    mode: ScheduleMode,
    /// Endgame 모드 진입 임계값 (남은 조각 수)
    endgame_threshold: usize,
}

impl Scheduler {
    pub fn new(total_pieces: usize) -> Self {
        Self {
            total_pieces,
            piece_frequency: vec![0; total_pieces],
            my_pieces: HashSet::new(),
            pending_pieces: HashSet::new(),
            peer_pieces: HashMap::new(),
            mode: ScheduleMode::RandomFirst,
            endgame_threshold: 10, // 마지막 10개 조각부터 Endgame
        }
    }

    /// 피어의 Bitfield 전체 업데이트 (Handshake 시)
    pub fn set_peer_bitfield(&mut self, peer_id: &str, piece_indices: Vec<usize>) {
        // 기존 정보가 있다면 빈도수 차감
        if let Some(old_pieces) = self.peer_pieces.remove(peer_id) {
            for idx in old_pieces {
                if idx < self.total_pieces {
                    self.piece_frequency[idx] = self.piece_frequency[idx].saturating_sub(1);
                }
            }
        }

        // 새 정보 추가
        let mut new_pieces = HashSet::new();
        for idx in piece_indices {
            if idx < self.total_pieces {
                self.piece_frequency[idx] += 1;
                new_pieces.insert(idx);
            }
        }

        self.peer_pieces.insert(peer_id.to_string(), new_pieces);
        self.update_mode();
    }

    /// 피어가 새 조각을 받았음을 알림 (Have 메시지)
    pub fn peer_has_piece(&mut self, peer_id: &str, piece_index: usize) {
        if piece_index >= self.total_pieces {
            return;
        }

        self.piece_frequency[piece_index] += 1;

        self.peer_pieces
            .entry(peer_id.to_string())
            .or_insert_with(HashSet::new)
            .insert(piece_index);

        self.update_mode();
    }

    /// 피어 연결 해제 시 호출
    pub fn remove_peer(&mut self, peer_id: &str) {
        if let Some(pieces) = self.peer_pieces.remove(peer_id) {
            for idx in pieces {
                if idx < self.total_pieces {
                    self.piece_frequency[idx] = self.piece_frequency[idx].saturating_sub(1);
                }
            }
        }
        self.update_mode();
    }

    /// 다운로드 완료 처리
    pub fn mark_completed(&mut self, index: usize) {
        self.my_pieces.insert(index);
        self.pending_pieces.remove(&index);
        self.update_mode();

        debug!(
            "Piece {} completed. Progress: {}/{}",
            index,
            self.my_pieces.len(),
            self.total_pieces
        );
    }

    /// 요청 시작 표시
    pub fn mark_pending(&mut self, index: usize) {
        self.pending_pieces.insert(index);
    }

    /// 요청 취소/실패 시
    pub fn unmark_pending(&mut self, index: usize) {
        self.pending_pieces.remove(&index);
    }

    /// 스케줄링 모드 업데이트
    fn update_mode(&mut self) {
        let remaining = self.total_pieces - self.my_pieces.len();

        self.mode = if self.my_pieces.is_empty() {
            ScheduleMode::RandomFirst
        } else if remaining <= self.endgame_threshold {
            ScheduleMode::Endgame
        } else {
            ScheduleMode::RareFirst
        };
    }

    /// 현재 모드 반환
    pub fn mode(&self) -> ScheduleMode {
        self.mode
    }

    /// 특정 피어에게 요청할 다음 조각 선정
    pub fn next_piece_for_peer(&self, peer_id: &str) -> Option<usize> {
        let peer_pieces = self.peer_pieces.get(peer_id)?;

        // 1. 후보 조각: 피어가 가지고 있고, 내가 없고, 요청 중이 아닌 것
        let candidates: Vec<usize> = peer_pieces
            .iter()
            .filter(|&&idx| !self.my_pieces.contains(&idx) && !self.pending_pieces.contains(&idx))
            .copied()
            .collect();

        if candidates.is_empty() {
            return None;
        }

        match self.mode {
            ScheduleMode::RandomFirst => {
                // 무작위 선택
                candidates.choose(&mut thread_rng()).copied()
            }
            ScheduleMode::RareFirst => {
                // 희귀도 정렬 후 상위 N개 중 무작위
                self.select_rarest(&candidates)
            }
            ScheduleMode::Endgame => {
                // Endgame: 이미 요청 중인 것도 포함하여 선택
                let endgame_candidates: Vec<usize> = peer_pieces
                    .iter()
                    .filter(|&&idx| !self.my_pieces.contains(&idx))
                    .copied()
                    .collect();

                self.select_rarest(&endgame_candidates)
            }
        }
    }

    /// 희귀도 기반 선택 (상위 N개 중 무작위)
    fn select_rarest(&self, candidates: &[usize]) -> Option<usize> {
        if candidates.is_empty() {
            return None;
        }

        // 희귀도 정렬
        let mut sorted: Vec<(usize, usize)> = candidates
            .iter()
            .map(|&idx| (idx, self.piece_frequency[idx]))
            .collect();

        sorted.sort_by_key(|(_, freq)| *freq);

        // 상위 10개 중 무작위 선택 (쏠림 방지)
        let range = std::cmp::min(sorted.len(), 10);
        let top_candidates: Vec<usize> = sorted[0..range].iter().map(|(idx, _)| *idx).collect();

        top_candidates.choose(&mut thread_rng()).copied()
    }

    /// 여러 피어에게 요청할 조각 목록 생성
    pub fn generate_requests(&self, max_requests: usize) -> Vec<PieceRequest> {
        let mut requests = Vec::new();
        let mut used_pieces: HashSet<usize> = HashSet::new();

        // 각 피어별로 요청 생성
        for (peer_id, peer_pieces) in &self.peer_pieces {
            if requests.len() >= max_requests {
                break;
            }

            // 이 피어에게 요청할 수 있는 조각
            let candidates: Vec<usize> = peer_pieces
                .iter()
                .filter(|&&idx| {
                    !self.my_pieces.contains(&idx)
                        && !self.pending_pieces.contains(&idx)
                        && !used_pieces.contains(&idx)
                })
                .copied()
                .collect();

            if let Some(piece_idx) = self.select_rarest(&candidates) {
                let priority = if self.piece_frequency[piece_idx] == 1 {
                    100 // 유일한 복제본 - 최우선
                } else {
                    (100 - self.piece_frequency[piece_idx].min(99)) as u32
                };

                requests.push(PieceRequest {
                    piece_index: piece_idx,
                    target_peer: peer_id.clone(),
                    priority,
                });

                used_pieces.insert(piece_idx);
            }
        }

        // 우선순위 정렬
        requests.sort_by(|a, b| b.priority.cmp(&a.priority));
        requests
    }

    /// Endgame 모드에서 모든 피어에게 요청할 조각 목록
    pub fn endgame_requests(&self) -> Vec<(usize, Vec<PeerId>)> {
        if self.mode != ScheduleMode::Endgame {
            return Vec::new();
        }

        let missing: Vec<usize> = (0..self.total_pieces)
            .filter(|idx| !self.my_pieces.contains(idx))
            .collect();

        missing
            .into_iter()
            .map(|piece_idx| {
                let peers: Vec<PeerId> = self
                    .peer_pieces
                    .iter()
                    .filter(|(_, pieces)| pieces.contains(&piece_idx))
                    .map(|(peer_id, _)| peer_id.clone())
                    .collect();
                (piece_idx, peers)
            })
            .collect()
    }

    /// 통계 정보
    pub fn stats(&self) -> SchedulerStats {
        let rarest_piece = self
            .piece_frequency
            .iter()
            .enumerate()
            .filter(|(idx, _)| !self.my_pieces.contains(idx))
            .min_by_key(|(_, &freq)| freq)
            .map(|(idx, &freq)| (idx, freq));

        SchedulerStats {
            total_pieces: self.total_pieces,
            completed: self.my_pieces.len(),
            pending: self.pending_pieces.len(),
            connected_peers: self.peer_pieces.len(),
            mode: self.mode,
            rarest_piece,
        }
    }

    /// 완료 여부
    pub fn is_complete(&self) -> bool {
        self.my_pieces.len() == self.total_pieces
    }

    /// 진행률
    pub fn progress(&self) -> f32 {
        if self.total_pieces == 0 {
            return 1.0;
        }
        self.my_pieces.len() as f32 / self.total_pieces as f32
    }
}

/// 스케줄러 통계
#[derive(Debug, Clone)]
pub struct SchedulerStats {
    pub total_pieces: usize,
    pub completed: usize,
    pub pending: usize,
    pub connected_peers: usize,
    pub mode: ScheduleMode,
    pub rarest_piece: Option<(usize, usize)>, // (index, frequency)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scheduler_creation() {
        let scheduler = Scheduler::new(100);
        assert_eq!(scheduler.total_pieces, 100);
        assert_eq!(scheduler.mode(), ScheduleMode::RandomFirst);
    }

    #[test]
    fn test_peer_bitfield() {
        let mut scheduler = Scheduler::new(10);

        scheduler.set_peer_bitfield("peer1", vec![0, 1, 2, 3, 4]);
        scheduler.set_peer_bitfield("peer2", vec![5, 6, 7, 8, 9]);

        assert_eq!(scheduler.piece_frequency[0], 1);
        assert_eq!(scheduler.piece_frequency[5], 1);
    }

    #[test]
    fn test_rare_first_selection() {
        let mut scheduler = Scheduler::new(10);

        // peer1은 모든 조각 보유
        scheduler.set_peer_bitfield("peer1", (0..10).collect());
        // peer2는 0번만 보유
        scheduler.set_peer_bitfield("peer2", vec![0]);

        // 0번 조각이 가장 많이 복제됨 (2개)
        assert_eq!(scheduler.piece_frequency[0], 2);
        assert_eq!(scheduler.piece_frequency[1], 1);

        // 1번 조각이 더 희귀하므로 우선 선택되어야 함
        scheduler.mark_completed(0); // 0번은 이미 받음
        scheduler.mode = ScheduleMode::RareFirst;

        // peer1에게 요청할 조각은 1~9 중 하나 (모두 빈도 1)
        let next = scheduler.next_piece_for_peer("peer1");
        assert!(next.is_some());
        assert!(next.unwrap() >= 1 && next.unwrap() <= 9);
    }

    #[test]
    fn test_endgame_mode() {
        let mut scheduler = Scheduler::new(15);
        scheduler.endgame_threshold = 5;

        scheduler.set_peer_bitfield("peer1", (0..15).collect());

        // 10개 완료 -> 5개 남음 -> Endgame
        for i in 0..10 {
            scheduler.mark_completed(i);
        }

        assert_eq!(scheduler.mode(), ScheduleMode::Endgame);
    }

    #[test]
    fn test_generate_requests() {
        let mut scheduler = Scheduler::new(10);

        scheduler.set_peer_bitfield("peer1", vec![0, 1, 2]);
        scheduler.set_peer_bitfield("peer2", vec![3, 4, 5]);
        scheduler.set_peer_bitfield("peer3", vec![6, 7, 8, 9]);

        let requests = scheduler.generate_requests(5);
        assert!(!requests.is_empty());
        assert!(requests.len() <= 5);
    }
}
