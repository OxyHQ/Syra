import * as Clipboard from 'expo-clipboard';

/**
 * Copy text to the clipboard on web and native. `expo-clipboard` provides a
 * single async API for both platforms.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
