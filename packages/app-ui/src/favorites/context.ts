/**
 * What the app can do with Favorites (ADR-0027), handed down to the shared views: the star in a page's header, the tree
 * rows' menus, the tab menu. The desktop provides it in its shell (Private Space and workspace pages); the web client
 * in its own (workspace pages). Without a provider no view offers a star.
 */
import { createContext, useContext } from "react";

export type FavoriteRef = { kind: "private"; path: string } | { kind: "workspace"; server: string; workspace: string; page: string };

export interface FavoritesApi {
  /** True when the page is a favorite now. */
  has(ref: FavoriteRef): boolean;
  /** Stars or unstars the page (it says so in its live region; a failure is shown by the app). */
  toggle(ref: FavoriteRef): void;
  /** False where the page cannot be starred (a workspace whose account is unknown). */
  can(ref: FavoriteRef): boolean;
}

export const FavoritesContext = createContext<FavoritesApi | null>(null);

export const useFavorites = (): FavoritesApi | null => useContext(FavoritesContext);
