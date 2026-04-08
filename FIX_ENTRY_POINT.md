# Fix Entry Point Error

## Issue
Web bundling fails with error:
```
Unable to resolve "../../App" from "node_modules/expo/AppEntry.js"
```

## Solution

The package.json already has the correct entry point:
```json
"main": "expo-router/entry"
```

This error is typically caused by cached Metro bundler configuration. Try these steps:

1. **Clear all caches:**
   ```bash
   cd packages/frontend
   rm -rf .expo node_modules/.cache .metro
   ```

2. **Restart the dev server with clean cache:**
   ```bash
   npm run dev -- --clear
   ```
   
   Or for web specifically:
   ```bash
   npm run web -- --clear
   ```

3. **If the issue persists**, the entry point is correctly configured in package.json (`expo-router/entry`), and the app directory structure is correct. The error should resolve after clearing caches and restarting.

## Verification

The app structure is correct:
- ✅ `app/_layout.tsx` exists (root layout)
- ✅ `app/index.tsx` exists (home screen)
- ✅ `package.json` has `"main": "expo-router/entry"`
- ✅ `app.config.js` has `expo-router` plugin enabled

The bundler just needs to pick up the correct entry point after cache is cleared.






