/**
 * An author's mark: the first character of their handle, boxed.
 *
 * There are no uploaded avatars on ARCANA, so this is not a placeholder for
 * one — it is the whole feature. The tint is a hash of the handle into four
 * palette pairs, so the same person looks the same on every page and a thread
 * with several voices can be told apart at a glance.
 */
export function Avatar({ handle, small = false }: { handle: string; small?: boolean }) {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) | 0;
  const tint = Math.abs(h) % 4;
  const initial = Array.from(handle.trim())[0] ?? '?';
  return (
    <span className={`fm-av fm-av-${tint}${small ? ' fm-av-sm' : ''}`} aria-hidden="true">
      {initial}
    </span>
  );
}
