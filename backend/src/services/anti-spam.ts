import { initDb } from "./db.js";
import { log } from "./logger.js";

export interface FlagResult {
  success: boolean;
  hidden: boolean;
  flagCount: number;
  threshold: number;
}

export interface FlagStatus {
  flagged: boolean;
  hidden: boolean;
  flagCount: number;
}

export function checkCommitmentRateLimit(
  commitment: string,
  daoId: number,
  proposalId: number,
  maxPerWindow: number,
  windowMs: number,
): boolean {
  const database = initDb();
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  const row = database
    .prepare(
      "SELECT count FROM comment_submissions WHERE commitment = ? AND dao_id = ? AND proposal_id = ? AND window_start = ?",
    )
    .get(commitment, daoId, proposalId, windowStart) as
    | { count: number }
    | undefined;

  if (row && row.count >= maxPerWindow) {
    log("warn", "commitment_rate_limit_exceeded", {
      commitment: commitment.slice(0, 16),
      daoId,
      proposalId,
      count: row.count,
      max: maxPerWindow,
    });
    return false;
  }

  return true;
}

export function recordCommentSubmission(
  commitment: string,
  daoId: number,
  proposalId: number,
  windowMs: number,
): void {
  const database = initDb();
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  database
    .prepare(
      `
    INSERT INTO comment_submissions (commitment, dao_id, proposal_id, window_start, count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(commitment, dao_id, proposal_id, window_start)
    DO UPDATE SET count = count + 1
  `,
    )
    .run(commitment, daoId, proposalId, windowStart);
}

export function flagComment(
  commentId: number,
  daoId: number,
  proposalId: number,
  flaggerCommitment: string,
  flaggerNullifier: string,
  threshold: number,
): FlagResult {
  const database = initDb();

  const existing = database
    .prepare(
      "SELECT id FROM comment_flags WHERE comment_id = ? AND dao_id = ? AND proposal_id = ? AND flagger_nullifier = ?",
    )
    .get(commentId, daoId, proposalId, flaggerNullifier);

  if (existing) {
    const countRow = database
      .prepare(
        "SELECT COUNT(*) as cnt FROM comment_flags WHERE comment_id = ? AND dao_id = ? AND proposal_id = ?",
      )
      .get(commentId, daoId, proposalId) as { cnt: number };

    log("info", "comment_flag_duplicate", { commentId, daoId, proposalId });
    return {
      success: false,
      hidden: countRow.cnt >= threshold,
      flagCount: countRow.cnt,
      threshold,
    };
  }

  database
    .prepare(
      `
    INSERT INTO comment_flags (comment_id, dao_id, proposal_id, flagger_commitment, flagger_nullifier)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(commentId, daoId, proposalId, flaggerCommitment, flaggerNullifier);

  const countRow = database
    .prepare(
      "SELECT COUNT(*) as cnt FROM comment_flags WHERE comment_id = ? AND dao_id = ? AND proposal_id = ?",
    )
    .get(commentId, daoId, proposalId) as { cnt: number };

  const hidden = countRow.cnt >= threshold;

  if (hidden) {
    database
      .prepare(
        `
      INSERT OR REPLACE INTO hidden_comments (comment_id, dao_id, proposal_id, flag_count, hidden_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `,
      )
      .run(commentId, daoId, proposalId, countRow.cnt);

    log("info", "comment_auto_hidden", {
      commentId,
      daoId,
      proposalId,
      flagCount: countRow.cnt,
      threshold,
    });
  }

  log("info", "comment_flagged", {
    commentId,
    daoId,
    proposalId,
    flagCount: countRow.cnt,
    threshold,
    hidden,
  });

  return { success: true, hidden, flagCount: countRow.cnt, threshold };
}

export function getFlagStatus(
  commentId: number,
  daoId: number,
  proposalId: number,
): FlagStatus {
  const database = initDb();

  const flagCount = database
    .prepare(
      "SELECT COUNT(*) as cnt FROM comment_flags WHERE comment_id = ? AND dao_id = ? AND proposal_id = ?",
    )
    .get(commentId, daoId, proposalId) as { cnt: number };

  const hidden = database
    .prepare(
      "SELECT comment_id FROM hidden_comments WHERE comment_id = ? AND dao_id = ? AND proposal_id = ?",
    )
    .get(commentId, daoId, proposalId);

  return {
    flagged: flagCount.cnt > 0,
    hidden: !!hidden,
    flagCount: flagCount.cnt,
  };
}

export function getHiddenCommentIds(
  daoId: number,
  proposalId: number,
): number[] {
  const database = initDb();
  const rows = database
    .prepare(
      "SELECT comment_id FROM hidden_comments WHERE dao_id = ? AND proposal_id = ?",
    )
    .all(daoId, proposalId) as Array<{ comment_id: number }>;

  return rows.map((r) => r.comment_id);
}
