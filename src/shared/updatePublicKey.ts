// Public half of Flowa's update signing key.
// The private key stays on the release Mac and is never committed.
//   bash scripts/generate-update-key.sh
// rewrites this constant, then commit this file before `npm run release`.
export const UPDATE_PUBLIC_KEY = ''
