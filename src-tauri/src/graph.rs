//! 커밋 그래프 레인 계산 (순수 함수).
//!
//! 입력은 `git log --topo-order` 순서의 커밋 목록이다. 자식이 항상 부모보다 먼저 나온다.
//! 각 행마다 "이 행 안에서 그릴 선분"을 계산해 돌려주고, 프런트엔드는 그대로 그리기만 한다.
//!
//! 규칙
//! - 레인 슬롯은 "다음에 나올 것으로 기대하는 커밋"을 담는다.
//! - 커밋은 자기를 기대하던 첫 레인에 놓인다. 다른 레인들도 기대하고 있었다면 그 선들이 노드로 모인다.
//! - 첫 번째 부모는 항상 노드의 레인을 물려받는다(같은 부모를 여러 레인이 기다릴 수 있다).
//!   그 부모 행에 오면 기다리던 레인들이 가장 왼쪽 레인으로 모인다 → 메인 줄기가 곧게 유지된다.
//! - 나머지 부모(merge)는 이미 기다리는 레인이 있으면 그리로 합류하고, 없으면 빈 레인을 새로 연다.

use serde::Serialize;
use std::collections::HashMap;

use crate::git::Commit;

/// 행 안의 세로 위치: 0 = 위 끝, 1 = 노드(가운데), 2 = 아래 끝
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub from_lane: usize,
    pub from_y: u8,
    pub to_lane: usize,
    pub to_y: u8,
    pub color: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub lane: usize,
    pub color: usize,
    pub segments: Vec<Segment>,
    /// 이 행을 그리는 데 필요한 레인 수
    pub width: usize,
}

#[derive(Clone)]
struct Slot {
    sha: String,
    color: usize,
}

fn free_slot(lanes: &mut Vec<Option<Slot>>) -> usize {
    if let Some(i) = lanes.iter().position(Option::is_none) {
        i
    } else {
        lanes.push(None);
        lanes.len() - 1
    }
}

pub fn layout(commits: &[Commit]) -> Vec<GraphRow> {
    let mut lanes: Vec<Option<Slot>> = Vec::new();
    let mut next_color = 0usize;
    let mut rows = Vec::with_capacity(commits.len());

    for c in commits {
        let width_before = lanes.len();
        let hits: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().filter(|s| s.sha == c.sha).map(|_| i))
            .collect();

        let (lane, color) = match hits.first() {
            Some(&i) => (i, lanes[i].as_ref().unwrap().color),
            None => {
                let i = free_slot(&mut lanes);
                let col = next_color;
                next_color += 1;
                (i, col)
            }
        };

        let mut segments = Vec::new();
        // 지나가는 레인: 위에서 아래로 곧게
        for (i, s) in lanes.iter().enumerate() {
            if let Some(s) = s {
                if s.sha != c.sha {
                    segments.push(Segment { from_lane: i, from_y: 0, to_lane: i, to_y: 2, color: s.color });
                }
            }
        }
        // 이 커밋을 기대하던 레인들: 위에서 노드로 모인다
        for &h in &hits {
            let col = lanes[h].as_ref().unwrap().color;
            segments.push(Segment { from_lane: h, from_y: 0, to_lane: lane, to_y: 1, color: col });
            lanes[h] = None;
        }

        // 부모 연결
        for (pi, p) in c.parents.iter().enumerate() {
            if pi == 0 {
                lanes[lane] = Some(Slot { sha: p.clone(), color });
                segments.push(Segment { from_lane: lane, from_y: 1, to_lane: lane, to_y: 2, color });
                continue;
            }
            let existing = lanes
                .iter()
                .enumerate()
                .find_map(|(i, s)| s.as_ref().filter(|s| &s.sha == p).map(|s| (i, s.color)));
            match existing {
                Some((k, col)) => {
                    // 이미 다른 레인이 이 부모를 기다린다 → 그 레인으로 합류
                    segments.push(Segment { from_lane: lane, from_y: 1, to_lane: k, to_y: 2, color: col });
                }
                None => {
                    let k = free_slot(&mut lanes);
                    let col = next_color;
                    next_color += 1;
                    lanes[k] = Some(Slot { sha: p.clone(), color: col });
                    segments.push(Segment { from_lane: lane, from_y: 1, to_lane: k, to_y: 2, color: col });
                }
            }
        }

        let width = width_before.max(lanes.len()).max(lane + 1);
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }

        rows.push(GraphRow {
            sha: c.sha.clone(),
            parents: c.parents.clone(),
            author: c.author.clone(),
            email: c.email.clone(),
            time: c.time,
            subject: c.subject.clone(),
            lane,
            color,
            segments,
            width,
        });
    }
    rows
}

/// 주어진 커밋에서 첫 번째 부모만 따라간 sha 집합 (브랜치 "줄기" 강조용)
pub fn first_parent_chain(commits: &[Commit], start: &str, max: usize) -> Vec<String> {
    let by_sha: HashMap<&str, &Commit> = commits.iter().map(|c| (c.sha.as_str(), c)).collect();
    let mut out = Vec::new();
    let mut cur = Some(start);
    while let Some(sha) = cur {
        if out.len() >= max {
            break;
        }
        let Some(c) = by_sha.get(sha) else { break };
        out.push(c.sha.clone());
        cur = c.parents.first().map(String::as_str);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> Commit {
        Commit {
            sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            subject: sha.into(),
        }
    }

    fn lanes(rows: &[GraphRow]) -> Vec<usize> {
        rows.iter().map(|r| r.lane).collect()
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let rows = layout(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert_eq!(lanes(&rows), vec![0, 0, 0]);
        assert!(rows.iter().all(|r| r.width == 1));
        // 루트 커밋은 아래로 나가는 선이 없다
        assert!(rows[2].segments.iter().all(|s| s.to_y != 2));
    }

    #[test]
    fn branch_and_merge() {
        //   m        (main, merge of b2 into a2)
        //   |\
        //   a2 b2
        //   |  b1
        //   | /
        //   a1
        let rows = layout(&[
            c("m", &["a2", "b2"]),
            c("b2", &["b1"]),
            c("a2", &["a1"]),
            c("b1", &["a1"]),
            c("a1", &[]),
        ]);
        assert_eq!(lanes(&rows), vec![0, 1, 0, 1, 0]);
        // merge 커밋에서 두 번째 부모로 가는 선
        assert!(rows[0].segments.contains(&Segment { from_lane: 0, from_y: 1, to_lane: 1, to_y: 2, color: rows[1].color }));
        // a1 에서 두 레인이 모인다 (갈라진 지점에서 합쳐 그림)
        let into_a1: Vec<_> = rows[4].segments.iter().filter(|s| s.to_y == 1).collect();
        assert_eq!(into_a1.len(), 2);
        assert!(into_a1.iter().all(|s| s.to_lane == 0));
        assert_eq!(rows[4].width, 2);
        // 서로 다른 브랜치는 다른 색
        assert_ne!(rows[0].color, rows[1].color);
    }

    #[test]
    fn two_tips_sharing_parent_converge_at_parent() {
        // x 와 y 가 모두 base 에서 갈라짐
        let rows = layout(&[c("x", &["base"]), c("y", &["base"]), c("base", &[])]);
        assert_eq!(lanes(&rows), vec![0, 1, 0]);
        // y 는 자기 레인으로 내려가다 base 에서 레인 0 으로 모인다
        assert!(rows[1].segments.contains(&Segment { from_lane: 1, from_y: 1, to_lane: 1, to_y: 2, color: rows[1].color }));
        assert!(rows[2].segments.contains(&Segment { from_lane: 1, from_y: 0, to_lane: 0, to_y: 1, color: rows[1].color }));
        assert_eq!(rows[2].width, 2);
    }

    #[test]
    fn lane_slots_are_released_after_convergence() {
        let rows = layout(&[c("x", &["base"]), c("y", &["base"]), c("base", &["root"]), c("root", &[])]);
        assert_eq!(rows[3].width, 1);
    }

    #[test]
    fn octopus_merge_opens_lanes() {
        let rows = layout(&[
            c("m", &["a", "b", "d"]),
            c("d", &["r"]),
            c("b", &["r"]),
            c("a", &["r"]),
            c("r", &[]),
        ]);
        assert_eq!(rows[0].segments.iter().filter(|s| s.from_y == 1).count(), 3);
        assert_eq!(rows[0].width, 3);
        assert_eq!(rows[4].lane, 0);
    }

    #[test]
    fn freed_lane_is_reused() {
        // f 브랜치가 머지되어 닫힌 뒤 새 팁 g 가 그 자리를 다시 쓴다
        let rows = layout(&[
            c("g", &["m"]),
            c("m", &["a", "f"]),
            c("f", &["a"]),
            c("a", &[]),
        ]);
        assert_eq!(rows[0].lane, 0);
        assert!(rows.iter().all(|r| r.width <= 2));
    }

    #[test]
    fn every_segment_stays_within_width() {
        let rows = layout(&[
            c("h", &["g", "e"]),
            c("g", &["f"]),
            c("e", &["d", "c"]),
            c("f", &["b"]),
            c("d", &["b"]),
            c("c", &["a"]),
            c("b", &["a"]),
            c("a", &[]),
        ]);
        for r in &rows {
            for s in &r.segments {
                assert!(s.from_lane < r.width && s.to_lane < r.width, "{r:?}");
            }
        }
    }

    #[test]
    fn first_parent_chain_follows_mainline() {
        let commits = [c("m", &["a2", "b2"]), c("b2", &["a1"]), c("a2", &["a1"]), c("a1", &[])];
        assert_eq!(first_parent_chain(&commits, "m", 10), vec!["m", "a2", "a1"]);
    }
}
