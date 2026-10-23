// Public half of Flowa's update signing key.
// The private key stays on the release Mac and is never committed.
//   bash scripts/generate-update-key.sh
// rewrites this constant, then commit this file before `npm run release`.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnXjojLpFurr7/cVuY7h8+6FStGHqyfkzSmb6S1Xgmi8=
-----END PUBLIC KEY-----
`
