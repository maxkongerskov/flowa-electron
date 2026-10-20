/** Keep a single-flight promise chain alive after a job throws. */
export function continueQueue(queue: Promise<void>, job: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
  return queue.then(job).catch((err: unknown) => {
    onError(err)
  })
}
