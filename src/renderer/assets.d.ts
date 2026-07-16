// Static image imports bundled by Vite (fingerprinted into the build on both
// the desktop Electron and mobile/www targets). Public-dir URLs are NOT safe
// in desktop Electron (it loads its own out-dir index.html), so renderer code
// imports images as modules instead.
declare module "*.png" {
  const src: string;
  export default src;
}
