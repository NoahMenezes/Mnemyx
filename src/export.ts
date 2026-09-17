// ---------------------------------------------------------------------------
// Phase 11: shareable exports. Sessions and commit stories rendered as
// standalone redacted markdown for PRs, wikis, or teammates.
//
// Safety design (read before touching): these builders accept ONLY
// already-formatted text (formatSession / formatCommitStory output).
// Secrets are masked upstream by the format choke point, so export is
// architecturally incapable of leaking what display already hides —
// there is no raw-row path through this module. Tests plant fake
// secrets and assert they never survive.
// ---------------------------------------------------------------------------

import { REDACTED } from "./redact.ts";

export interface BuiltExport {
  markdown: string;
  /** How many [redacted] markers the body carries (frontmatter reports it). */
  redactedCount: number;
}

function frontmatter(lines: string[], redactedCount: number): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `source: mnemyx export (local-only, ${date})`,
    ...lines,
    `secrets: masked (${redactedCount} redaction${redactedCount === 1 ? "" : "s"})`,
    "---",
  ].join("\n");
}

function countRedactions(body: string): number {
  return body.split(REDACTED).length - 1;
}

// Export one session's full detail (the formatSession text verbatim).
export function buildSessionExport(sessionId: string, detail: string): BuiltExport {
  const redactedCount = countRedactions(detail);
  const markdown = [
    frontmatter([`type: session ${sessionId}`], redactedCount),
    "",
    detail,
  ].join("\n");
  return { markdown, redactedCount };
}

// Export one commit's story (the formatCommitStory text verbatim).
export function buildStoryExport(
  shortHash: string,
  fullHash: string,
  story: string
): BuiltExport {
  const redactedCount = countRedactions(story);
  const markdown = [
    frontmatter([`type: commit-story ${shortHash} (${fullHash})`], redactedCount),
    "",
    story,
  ].join("\n");
  return { markdown, redactedCount };
}
