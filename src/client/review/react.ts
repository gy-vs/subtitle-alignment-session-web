import { useEffect, useState } from 'react';
import type { SuggestionReviewSession, ViewItem } from './session';

/**
 * Bind a review session to React: re-reads the filtered, cue-ordered view
 * whenever the session notifies. Filtering stays a view concern here —
 * pass a different filter via `session.setFilter(...)` and the hook just
 * re-renders.
 */
export function useReviewItems(session: SuggestionReviewSession | null): ViewItem[] {
  const [items, setItems] = useState<ViewItem[]>(() => (session ? session.visible() : []));
  useEffect(() => {
    if (!session) {
      setItems([]);
      return;
    }
    const update = () => setItems(session.visible());
    update();
    return session.subscribe(update);
  }, [session]);
  return items;
}
