/** A sample vault: pages as Markdown, paths relative to the vault ("Recipes/Lemon cake.md"). */
export interface DemoVault {
  /** The vault folder's name ("notes"). */
  name: string;
  /** The page that opens first. */
  first: string;
  folders: string[];
  pages: { path: string; source: string }[];
}
