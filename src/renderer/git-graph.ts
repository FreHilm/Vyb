// Lane allocation for the commit graph.
//
// Standard left-pack algorithm: each commit row sits in a "lane" (column),
// and we draw lines connecting commits to their parents through these lanes.
//
//   - Process commits newest → oldest (matching `git log` output).
//   - Maintain `nextLanes`: at each step, the SHA we expect next in each
//     lane (or null = free). When we reach the row whose SHA matches one
//     of those lanes, that lane becomes the commit's home.
//   - First parent inherits the commit's lane (linear history stays in one
//     column). Other parents reuse an existing lane that already points at
//     them, otherwise allocate the leftmost free lane.
//   - Multiple lanes pointing at the same SHA collapse into a single row;
//     the leftmost wins, the rest are freed.

import { GitCommit } from '../shared/types';

export interface GraphRow {
  sha: string;
  /** Column the commit dot sits in. */
  lane: number;
  /** Lane state above this row (lanes alive going into the row). */
  lanesBefore: (string | null)[];
  /** Lane state below this row (lanes alive leaving the row, projecting to parents). */
  lanesAfter: (string | null)[];
  /**
   * Lanes (other than `lane`) that converged into this commit from above —
   * each represents a diagonal incoming line from `fromLane` at the top of
   * the row to `lane` at the middle of the row.
   */
  incomingFrom: number[];
  /**
   * Outgoing edges from the commit dot to each parent's lane in the row
   * below. The first entry typically equals `lane` (linear continuation);
   * additional entries are merge/branch fan-out.
   */
  outgoingTo: number[];
}

function findFirstFree(lanes: (string | null)[]): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null) return i;
  }
  return lanes.length; // append a new lane
}

export function buildGraph(commits: GitCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  const nextLanes: (string | null)[] = [];

  for (const c of commits) {
    const lanesBefore = nextLanes.slice();

    // Find every lane currently waiting for this commit.
    const incoming: number[] = [];
    for (let i = 0; i < nextLanes.length; i++) {
      if (nextLanes[i] === c.sha) incoming.push(i);
    }

    let lane: number;
    if (incoming.length === 0) {
      lane = findFirstFree(nextLanes);
      if (lane === nextLanes.length) nextLanes.push(null);
    } else {
      lane = incoming[0];
      // Other lanes converging here are released — they collapse into `lane`.
      for (let i = 1; i < incoming.length; i++) {
        nextLanes[incoming[i]] = null;
      }
    }

    // Project outgoing lanes from this commit's parents.
    const outgoingTo: number[] = [];
    if (c.parents.length === 0) {
      // Root commit — lane terminates here.
      nextLanes[lane] = null;
    } else {
      // First parent stays in our lane.
      nextLanes[lane] = c.parents[0];
      outgoingTo.push(lane);

      for (let i = 1; i < c.parents.length; i++) {
        const p = c.parents[i];
        // If a lane is already pointing at this parent, reuse it (graph
        // converges below this row at that parent's commit).
        const existing = nextLanes.indexOf(p);
        let pLane: number;
        if (existing !== -1) {
          pLane = existing;
        } else {
          pLane = findFirstFree(nextLanes);
          if (pLane === nextLanes.length) nextLanes.push(null);
          nextLanes[pLane] = p;
        }
        outgoingTo.push(pLane);
      }
    }

    // Trim trailing nulls so the lane count tracks reality.
    while (nextLanes.length > 0 && nextLanes[nextLanes.length - 1] === null) {
      nextLanes.pop();
    }

    rows.push({
      sha: c.sha,
      lane,
      lanesBefore,
      lanesAfter: nextLanes.slice(),
      incomingFrom: incoming.slice(1), // lanes that collapsed *into* `lane`
      outgoingTo,
    });
  }

  return rows;
}

/** Maximum lane index across the whole graph — useful for sizing the SVG column. */
export function maxLane(rows: GraphRow[]): number {
  let m = 0;
  for (const r of rows) {
    if (r.lane > m) m = r.lane;
    if (r.lanesBefore.length - 1 > m) m = r.lanesBefore.length - 1;
    if (r.lanesAfter.length - 1 > m) m = r.lanesAfter.length - 1;
  }
  return m;
}
