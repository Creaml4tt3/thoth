import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { useFavorites, type FavoriteRef } from "./context.ts";

/**
 * The star in a page's header (ADR-0027): a toggle button (`aria-pressed`) with one name, "Favorite"; its tooltip says
 * what a press does and gives the shortcut. Nothing when the app has no Favorites or the page cannot be starred.
 */
export function FavoriteButton({ target }: { target: FavoriteRef }) {
  const favorites = useFavorites();
  const t = useStrings().favorites;
  if (!favorites || !favorites.can(target)) return null;
  const on = favorites.has(target);
  return (
    <IconButton
      icon="star"
      label={t.button}
      shortcut="page.favorite"
      className={on ? "fav-star fav-star-on" : "fav-star"}
      aria-pressed={on}
      data-tip={on ? t.remove : t.add}
      onClick={() => favorites.toggle(target)}
    />
  );
}
