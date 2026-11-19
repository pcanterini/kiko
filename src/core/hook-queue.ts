/**
 * The order held hook requests wait in to be announced. Permission prompts block their session, so
 * they go ahead of finished turns; each comes in at the back of its kind. `front` puts it first of
 * its kind instead: one whose announcement a press cut before it made any sound goes next.
 */
export function enqueue<R extends { isPermission: boolean }>(queue: R[], request: R, front = false) {
  const firstStop = queue.findIndex((r) => !r.isPermission);
  const stops = firstStop === -1 ? queue.length : firstStop;
  const at = request.isPermission ? (front ? 0 : stops) : front ? stops : queue.length;
  queue.splice(at, 0, request);
}
