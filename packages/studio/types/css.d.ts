/**
 * Ambient declaration for side-effect CSS imports (e.g. `import '../styles/global.css'`).
 * NativeWind/Metro handle the actual transformation; TypeScript 6 now validates
 * side-effect imports (TS2882), so the module shape must be declared.
 */
declare module '*.css';
