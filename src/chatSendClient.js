// A dropped SSE connection does not mean the durable local generation stopped.
// Re-submit the exact same semantic request key: the server will either replay
// the terminal receipt or report that the single owned generation is pending.
// The bounded backoff avoids both duplicate model calls and an endless busy UI.
export async function awaitChatSendResult({
  content,
  requestKey,
  send,
  onPending = () => {},
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  maxAttempts = 90,
  initialDelayMs = 200,
  maxDelayMs = 2000
}) {
  if (typeof send !== 'function') throw new Error('Chat send reconciliation requires a send function.');
  if (!requestKey) throw new Error('Chat send reconciliation requires the original request key.');
  let delayMs = Math.max(1, Number(initialDelayMs) || 200);
  const delayCapMs = Math.max(delayMs, Number(maxDelayMs) || 2000);
  const attempts = Math.max(1, Math.min(300, Number(maxAttempts) || 90));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await send({ content, requestKey });
    if (!result?.pending) return result;
    onPending({ attempt: attempt + 1, state: result.state || 'pending' });
    if (attempt === attempts - 1) return null;
    await wait(delayMs);
    delayMs = Math.min(delayCapMs, Math.ceil(delayMs * 1.5));
  }
  return null;
}

export function isChatSendOriginActive(currentSessionId, originSessionId, instanceActive = true) {
  return Boolean(instanceActive) && currentSessionId != null && originSessionId != null && String(currentSessionId) === String(originSessionId);
}

export function isLatestChatConnectionRequest(currentRequestId, requestId, currentSessionId, originSessionId, instanceActive = true) {
  return Number(currentRequestId) === Number(requestId)
    && isChatSendOriginActive(currentSessionId, originSessionId, instanceActive);
}
