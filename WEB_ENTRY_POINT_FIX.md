# Web Entry Point Fix

## Issue
Web bundling fails with:
```
Unable to resolve "../../App" from "node_modules/expo/AppEntry.js"
```

## Root Cause
Expo's web bundler is using the default `AppEntry.js` which looks for an `App.tsx` file, instead of using Expo Router's entry point.

## Solution

The configuration is correct (`"main": "expo-router/entry"` in package.json). The issue is likely a cached bundler configuration.

### Steps to Fix:

1. **Clear all caches:**
   ```bash
   cd packages/frontend
   rm -rf .expo node_modules/.cache .metro .next dist
   ```

2. **Restart dev server with clean cache:**
   ```bash
   npm run web -- --clear
   ```
   
   Or:
   ```bash
   npx expo start --web --clear
   ```

3. **If that doesn't work, try:**
   ```bash
   npx expo start --web --reset-cache
   ```

4. **For a complete fresh start:**
   ```bash
   # Clear everything
   rm -rf .expo node_modules/.cache .metro node_modules
   
   # Reinstall
   npm install
   
   # Start fresh
   npm run web -- --clear
   ```

## Verification

The configuration is correct:
- ✅ `package.json` has `"main": "expo-router/entry"`
- ✅ `app.config.js` has `expo-router` plugin enabled
- ✅ `app/_layout.tsx` exists (root layout)
- ✅ `app/index.tsx` exists (home screen)

The bundler just needs to pick up the correct entry point after cache is cleared.

## Alternative (if cache clearing doesn't work)

If the issue persists, you can temporarily create a root-level entry file:

```javascript
// packages/frontend/index.js
import 'expo-router/entry';
```

Then update `package.json`:
```json
{
  "main": "index.js"
}
```

But this should not be necessary - the `expo-router/entry` should work directly.






