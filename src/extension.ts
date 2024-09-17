import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DateTime } from 'luxon'; // Import DateTime from Luxon
const micromatch = require('micromatch');
import { LogEntry } from './types';
import { promisify } from 'util';
import { Semaphore } from 'await-semaphore';
import * as readline from 'readline';

// Promisify necessary fs functions for asynchronous operations
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const writeFile = promisify(fs.writeFile);

// Define the TimestampPattern interface
interface TimestampPattern {
  pattern: string;
  format: string;
}

// Define a semaphore to limit the number of concurrent file processing operations
const MAX_CONCURRENT_FILES = 10; // Adjust based on performance testing
const semaphore = new Semaphore(MAX_CONCURRENT_FILES);

// Cache configuration settings to avoid repeated retrievals
let configCache: {
  includePatterns: string[];
  excludePatterns: string[];
  customTimestampPatterns: TimestampPattern[];
  timestampFields: string[];
  keywords: string[];
} | null = null;

// Precompile static regular expressions outside of loops
const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d+Z/;

// Preprocess and compile custom regex patterns
interface CompiledTimestampPattern {
  regex: RegExp;
  format: string;
}

let compiledTimestampPatterns: CompiledTimestampPattern[] = [];

// Initialize configurations and compile regex patterns
async function initializeConfig() {
  if (configCache) return;

  configCache = {
    includePatterns: vscode.workspace.getConfiguration('logSearch').get<string[]>('includePatterns', ['**/*.log']),
    excludePatterns: vscode.workspace.getConfiguration('logSearch').get<string[]>('excludePatterns', ['**/node_modules/**']),
    customTimestampPatterns: vscode.workspace.getConfiguration('logSearch').get<TimestampPattern[]>('customTimestampRegexes', []),
    timestampFields: vscode.workspace.getConfiguration('logSearch').get<string[]>('timestampFields', ['created', 'modified']),
    keywords: vscode.workspace.getConfiguration('logSearch').get<string[]>('keywords', []),
  };

  // Compile custom timestamp regex patterns
  compiledTimestampPatterns = configCache.customTimestampPatterns.map(({ pattern, format }) => ({
    regex: new RegExp(pattern),
    format,
  }));
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    'logSearch.searchLogs',
    async () => {
      try {
        // Step 1: Folder Selection
        const folderUri = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select Log Folder',
        });

        if (!folderUri) {
          vscode.window.showErrorMessage('No folder selected');
          return;
        }

        const folderPath = folderUri[0].fsPath;

        // Step 2: Date Range Input
        const startDateInput = await vscode.window.showInputBox({
          prompt: 'Enter Start Date and Time in UTC (YYYY-MM-DD HH:MM:SS)',
          placeHolder: 'YYYY-MM-DD HH:mm:ss',
        });

        if (!startDateInput) {
          vscode.window.showErrorMessage('Start date is required');
          return;
        }

        const endDateInput = await vscode.window.showInputBox({
          prompt: 'Enter End Date and Time in UTC (YYYY-MM-DD HH:MM:SS)',
          placeHolder: 'YYYY-MM-DD HH:mm:ss',
        });

        if (!endDateInput) {
          vscode.window.showErrorMessage('End date is required');
          return;
        }

        const startDateTime = DateTime.fromFormat(
          startDateInput,
          'yyyy-MM-dd HH:mm:ss',
          { zone: 'utc' }
        );
        const endDateTime = DateTime.fromFormat(
          endDateInput,
          'yyyy-MM-dd HH:mm:ss',
          { zone: 'utc' }
        );

        if (!startDateTime.isValid || !endDateTime.isValid) {
          vscode.window.showErrorMessage('Invalid date format');
          return;
        }

        const startEpoch = startDateTime.toMillis();
        const endEpoch = endDateTime.toMillis();

        // Initialize configurations
        await initializeConfig();

        // Step 3: Progress Bar and Log Processing
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Searching Logs...',
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              vscode.window.showWarningMessage('Log search was canceled.');
            });

            const matchedEntries: LogEntry[] = [];

            try {
              const logFiles = await getLogFiles(folderPath);
              const totalFiles = logFiles.length;
              let processedFiles = 0;

              // Process files with limited concurrency
              const processingPromises = logFiles.map(async (file) => {
                const release = await semaphore.acquire();
                try {
                  await processLogFile(
                    file,
                    matchedEntries,
                    startEpoch,
                    endEpoch,
                    token
                  );
                  processedFiles++;
                  progress.report({
                    increment: (1 / totalFiles) * 100,
                    message: `Processing file ${processedFiles} of ${totalFiles}`,
                  });
                } finally {
                  release();
                }
              });

              await Promise.all(processingPromises);

              // Step 4: Sorting and Grouping Results
              matchedEntries.sort((a, b) => a.timestamp - b.timestamp);

              const groupedEntries = groupEntries(matchedEntries);

              // Step 5: Export Results to HTML
              await exportResultsToHtml(context, groupedEntries);
            } catch (err: any) {
              vscode.window.showErrorMessage(`Error during log search: ${err.message}`);
            }
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Unexpected error: ${err.message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

/**
 * Asynchronously retrieves log files based on include and exclude patterns.
 * Utilizes parallel directory traversal to enhance performance.
 */
async function getLogFiles(folderPath: string): Promise<string[]> {
  const { includePatterns, excludePatterns } = configCache!;

  const files: string[] = [];

  async function walkDirectory(dir: string) {
    let items: string[];
    try {
      items = await readdir(dir);
    } catch (err) {
      console.error(`Failed to read directory: ${dir}, err: ${err}`);
      return;
    }

    const statPromises = items.map(async (item) => {
      const itemPath = path.join(dir, item);
      let itemStats: fs.Stats;
      try {
        itemStats = await stat(itemPath);
      } catch (err) {
        console.error(`Failed to stat path: ${itemPath}, err: ${err}`);
        return;
      }

      if (itemStats.isFile()) {
        const relativePath = path.relative(folderPath, itemPath);
        if (
          micromatch.isMatch(relativePath, includePatterns) &&
          !micromatch.isMatch(relativePath, excludePatterns)
        ) {
          files.push(itemPath);
        }
      } else if (itemStats.isDirectory()) {
        await walkDirectory(itemPath);
      }
    });

    await Promise.all(statPromises);
  }

  await walkDirectory(folderPath);

  return files;
}

/**
 * Parses a line to extract a timestamp.
 * Utilizes precompiled custom regex patterns for efficiency.
 */
function parseTimestamp(line: string): number | null {
  for (const { regex, format } of compiledTimestampPatterns) {
    const match = line.match(regex);
    if (match) {
      const timestampString = match[1] || match[0];
      let dateTime = DateTime.now(); // Using let dateTime = DateTime.now();

      if (format === 'X') {
        dateTime = DateTime.fromSeconds(parseInt(timestampString, 10));
      } else if (format === 'x') {
        dateTime = DateTime.fromMillis(parseInt(timestampString, 10));
      } else {
        dateTime = DateTime.fromFormat(timestampString, format, { zone: 'utc' });
      }

      if (dateTime.isValid) {
        return dateTime.toMillis();
      }
    }
  }

  const match = line.match(isoRegex);
  if (match) {
    const dateTime = DateTime.fromISO(match[0], { zone: 'utc' });
    if (dateTime.isValid) {
      return dateTime.toMillis();
    }
  }

  return null;
}

/**
 * Extracts a timestamp from a JSON object based on configured timestamp fields.
 */
function extractTimestampFromJson(jsonObject: any): number | null {
  for (const field of configCache!.timestampFields) {
    if (jsonObject.hasOwnProperty(field)) {
      const timestamp = DateTime.fromISO(jsonObject[field], { zone: 'utc' });
      if (timestamp.isValid) {
        return timestamp.toMillis();
      }
    }
  }

  return null; // No valid timestamp found in JSON
}

/**
 * Checks if a timestamp is within the specified range.
 */
function isWithinRange(
  timestamp: number,
  startEpoch: number,
  endEpoch: number
): boolean {
  return timestamp >= startEpoch && timestamp <= endEpoch;
}

/**
 * Asynchronously processes a single log file to extract matching log entries.
 * Utilizes streams and readline for efficient line-by-line processing.
 */
async function processLogFile(
  filePath: string,
  matchedEntries: LogEntry[],
  startEpoch: number,
  endEpoch: number,
  token: vscode.CancellationToken
): Promise<void> {
  if (token.isCancellationRequested) {
    return;
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let jsonBuffer = '';
  let insideJson = false;
  let openBracesCount = 0;

  try {
    for await (const line of rl) {
      if (token.isCancellationRequested) {
        rl.close();
        fileStream.close();
        return;
      }

      lineNumber++;

      // Check if we are entering a JSON object
      if (line.trim().startsWith('{')) {
        insideJson = true;
        openBracesCount = 1;
        jsonBuffer = line;
        continue;
      }

      if (insideJson) {
        jsonBuffer += '\n' + line;
        openBracesCount += (line.match(/{/g) || []).length;
        openBracesCount -= (line.match(/}/g) || []).length;

        if (openBracesCount === 0) {
          insideJson = false;
          try {
            const jsonObject = JSON.parse(jsonBuffer);
            const timestamp = extractTimestampFromJson(jsonObject);
            if (timestamp && isWithinRange(timestamp, startEpoch, endEpoch)) {
              matchedEntries.push({
                timestamp,
                line: JSON.stringify(jsonObject),
                filePath,
                lineNumber,
              });
            }
          } catch (error) {
            console.error('Failed to parse JSON:', error);
          } finally {
            jsonBuffer = '';
          }
        }
        continue;
      }

      // Handle regular log lines (non-JSON)
      const timestamp = parseTimestamp(line);
      if (timestamp !== null && isWithinRange(timestamp, startEpoch, endEpoch)) {
        matchedEntries.push({
          timestamp,
          line,
          filePath,
          lineNumber,
        });
      }
    }

    // Handle any remaining JSON buffer
    if (jsonBuffer.length > 0 && insideJson) {
      try {
        const jsonObject = JSON.parse(jsonBuffer);
        const timestamp = extractTimestampFromJson(jsonObject);
        if (timestamp && isWithinRange(timestamp, startEpoch, endEpoch)) {
          matchedEntries.push({
            timestamp,
            line: JSON.stringify(jsonObject),
            filePath,
            lineNumber,
          });
        }
      } catch (error) {
        console.error('Failed to parse remaining JSON buffer:', error);
      }
    }
  } catch (err) {
    console.error(`Error processing file ${filePath}:`, err);
  } finally {
    rl.close();
    fileStream.close();
  }
}

/**
 * Groups log entries by file path and sequential timestamps.
 */
function groupEntries(entries: LogEntry[]): any[] {
  type Group = {
    filePath: string;
    startTimestamp: number;
    endTimestamp: number;
    entries: LogEntry[];
  };

  const groups: Group[] = [];
  let currentGroup: Group | null = null;

  for (const entry of entries) {
    if (
      currentGroup &&
      entry.filePath === currentGroup.filePath &&
      entry.timestamp >= currentGroup.startTimestamp &&
      entry.timestamp >= currentGroup.endTimestamp
    ) {
      currentGroup.entries.push(entry);
      currentGroup.endTimestamp = entry.timestamp;
    } else {
      currentGroup = {
        filePath: entry.filePath,
        startTimestamp: entry.timestamp,
        endTimestamp: entry.timestamp,
        entries: [entry],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

/**
 * Exports the grouped log entries to an external HTML file with search and highlight functionality.
 */
async function exportResultsToHtml(
  context: vscode.ExtensionContext,
  groupedEntries: any[]
) {
  if (groupedEntries.length === 0) {
    vscode.window.showInformationMessage('No logs found in the specified range.');
    return;
  }

  // Prompt user to choose a location to save the HTML file
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const defaultPath = workspaceFolders && workspaceFolders.length > 0
    ? path.join(workspaceFolders[0].uri.fsPath, 'logSearchResults.html')
    : path.join(vscode.workspace.rootPath || '', 'logSearchResults.html');

  const saveUri = await vscode.window.showSaveDialog({
    title: 'Save Log Search Results',
    defaultUri: vscode.Uri.file(defaultPath),
    filters: {
      'HTML Files': ['html'],
    },
  });

  if (!saveUri) {
    vscode.window.showErrorMessage('Save operation was canceled.');
    return;
  }

  // Generate HTML content
  const htmlContent = generateHtmlContent(groupedEntries);

  try {
    await writeFile(saveUri.fsPath, htmlContent, 'utf8');
    vscode.window.showInformationMessage(`Log search results exported to ${saveUri.fsPath}`);

    // Open the saved HTML file in the default browser
    const fileUri = vscode.Uri.file(saveUri.fsPath);
    await vscode.env.openExternal(fileUri);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to write HTML file: ${error.message}`);
  }
}

/**
 * Generates the HTML content for the exported log search results.
 * Includes dynamic search highlighting.
 */
function generateHtmlContent(groupedEntries: any[]): string {
  const keywords: string[] = configCache!.keywords;
  const highlightColor = '#ff66cc'; // Pink color for highlighting keywords

  // Function to escape HTML characters
  const escapeHtml = (unsafe: string): string =>
    unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  // Function to highlight predefined keywords
  const highlightKeywords = (text: string): string => {
    if (keywords.length > 0) {
      const escapedKeywords = keywords.map(escapeRegExp);
      const keywordRegex = new RegExp(`(${escapedKeywords.join('|')})`, 'gi');
      return text.replace(keywordRegex, `<strong>$1</strong>`);
    }
    return text;
  };

  let contentHtml = '';

  for (const group of groupedEntries) {
    const fileName = path.basename(group.filePath);
    const startTime = DateTime.fromMillis(group.startTimestamp, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss \'UTC\'');
    const endTime = DateTime.fromMillis(group.endTimestamp, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss \'UTC\'');

    let entriesHtml = '';
    for (const entry of group.entries) {
      const logTimestamp = DateTime.fromMillis(entry.timestamp, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss \'UTC\'');

      // Try to format the line as JSON and highlight it
      let formattedLogMessage: string;
      let jsonBadge = ''; // Initialize without badge

      try {
        const jsonObject = JSON.parse(entry.line);
        const jsonText = JSON.stringify(jsonObject, null, 2);
        formattedLogMessage = `<pre>${highlightKeywords(escapeHtml(jsonText))}</pre>`;
        // If it's a valid JSON, add the JSON badge
        jsonBadge = `<span class="json-badge" title="JSON Log Entry">🟢 JSON</span>`;
      } catch (e) {
        formattedLogMessage = `<pre>${highlightKeywords(escapeHtml(entry.line))}</pre>`;
      }

      entriesHtml += `
        <div class="log-entry">
          <span class="line-number">${entry.lineNumber}:</span>
          ${jsonBadge}
          <span class="utc-time">${logTimestamp}</span>
          <span class="log-message">${formattedLogMessage}</span>
        </div>
      `;
    }

    contentHtml += `
      <details>
        <summary>
          <span class="file-name">${escapeHtml(fileName)}</span>
          <span class="timestamp-range">(${escapeHtml(startTime)} - ${escapeHtml(endTime)})</span>
        </summary>
        ${entriesHtml}
      </details>
    `;
  }

  // JavaScript for dynamic filtering with debouncing and search string highlighting
  const script = `
    <script>
      document.addEventListener('DOMContentLoaded', function() {
        const searchInput = document.getElementById('searchInput');
        let debounceTimer;

        searchInput.addEventListener('input', function() {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const filter = searchInput.value.trim().toLowerCase();

            // Remove existing dynamic highlights
            const existingHighlights = document.querySelectorAll('.dynamic-highlight');
            existingHighlights.forEach(span => {
              const parent = span.parentNode;
              if (parent) {
                parent.replaceChild(document.createTextNode(span.textContent || ''), span);
                parent.normalize(); // Merge adjacent text nodes
              }
            });

            const logEntries = document.querySelectorAll('.log-entry');
            logEntries.forEach(entry => {
              const text = entry.textContent.toLowerCase();
              if (filter === '' || text.includes(filter)) {
                entry.style.display = '';
                // Highlight the search string within the log message
                if (filter !== '') {
                  const logMessage = entry.querySelector('.log-message');
                  if (logMessage) {
                    const regex = new RegExp('(' + escapeRegExp(filter) + ')', 'gi');
                    logMessage.innerHTML = logMessage.innerHTML.replace(regex, '<span class="dynamic-highlight">$1</span>');
                  }
                }
              } else {
                entry.style.display = 'none';
              }
            });

            // Hide/show groups based on visible entries
            const groups = document.querySelectorAll('details');
            groups.forEach(group => {
              const visibleEntries = group.querySelectorAll('.log-entry:not([style*="display: none"])');
              if (visibleEntries.length > 0) {
                group.style.display = '';
              } else {
                group.style.display = 'none';
              }
            });
          }, 300); // 300ms debounce
        });

        /**
         * Escapes special characters in a string for use in a regular expression.
         * @param {string} string - The string to escape.
         * @returns {string} - The escaped string.
         */
        function escapeRegExp(string) {
          return string.replace(/[.*+?^\\$\\{}()|[\\]\\\\]/g, '\\\\$&');
        }
      });
    </script>
  `;

  // CSS for styling, including dynamic highlight
  const style = `
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #2d2d2d;
      color: #d4d4d4;
      padding: 20px;
      font-size: 14px;
    }
    h1 {
      color: #ffffff;
    }
    #searchContainer {
      margin-bottom: 20px;
    }
    #searchInput {
      width: 100%;
      padding: 10px;
      font-size: 14px;
      border: 1px solid #555;
      border-radius: 5px;
      background-color: #3c3c3c;
      color: #d4d4d4;
    }
    details {
      border: 1px solid #444;
      border-radius: 5px;
      margin-bottom: 10px;
      padding: 10px;
      background-color: #333;
    }
    summary {
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      align-items: center;
      color: #ffffff;
    }
    .file-name {
      color: #bfbfbf;
      font-family: 'Consolas', 'Courier New', monospace;
      margin-right: 10px;
    }
    .timestamp-range {
      color: #8a8a8a;
    }
    .log-entry {
      padding: 4px 0;
      display: flex;
      align-items: flex-start;
    }
    .line-number {
      color: #888;
      margin-right: 5px;
      min-width: 40px;
    }
    .utc-time {
      color: #ff66cc;
      font-weight: bold;
      margin-right: 10px;
      white-space: nowrap;
    }
    .log-message {
      font-family: 'Consolas', 'Courier New', monospace;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #bfbfbf;
    }
    .json-badge {
      background-color: #58a6ff;
      color: white;
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      margin-left: 6px;
    }
    .json-badge:hover {
      background-color: #1f6feb;
    }
    pre {
      margin: 0;
    }
    strong {
      font-weight: bold;
      color: ${highlightColor};
    }
    .dynamic-highlight {
      background-color: yellow;
      color: black;
    }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Log Search Results</title>
  <style>${style}</style>
</head>
<body>
  <h1>Log Search Results</h1>
  <div id="searchContainer">
    <input type="text" id="searchInput" placeholder="Search logs...">
  </div>
  <div class="log-groups">
    ${contentHtml}
  </div>
  ${script}
</body>
</html>`;
}

/**
 * Escapes HTML characters to prevent injection.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escapes RegExp special characters in a string.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deactivate() {}
