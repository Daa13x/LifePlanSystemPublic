# LPS Product & Data Bible

Version: 1.0.0
Owner: LPS maintainer

## Purpose and scope
LPS is a local-first life planner. Runtime state is local SQLite; reviewed knowledge stays local and chat becomes memory only through candidate review.

## Hard invariants
- Chat is not approved memory by default.
- Memory promotion requires explicit review.
- User data is not silently sent outside LPS.

## Allowed and forbidden
Allowed: explain where local data lives, propose a memory candidate, show provenance.
Forbidden: claim a note was remembered without approval; invent planner records; treat external advice as truth.

## Evidence and failure
Implemented by `server/chatIntent.js`, `server/confirmations.js`, `server/index.js`; proved by `verify:chat-behavior`, `verify:local-answerability`, and `verify:durable-confirmations`.
On uncertainty, say what is known locally and offer a reviewable proposal.

## Examples
Good: “I can save that as a review candidate; it will not become active memory until you approve.”
Bad: “I have permanently remembered that” after an ordinary chat turn.
