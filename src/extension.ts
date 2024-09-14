import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DateTime } from 'luxon'; // Import DateTime from Luxon
const micromatch = require('micromatch');
import { LogEntry } from './types';

interface TimestampPattern {
  pattern: string;
  format: string;
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    'logSearch.searchLogs',
    async () => {
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
        prompt: 'Enter Start Date and Time (YYYY-MM-DD HH:MM:SS)',
        placeHolder: 'YYYY-MM-DD HH:mm:ss',
      });

      if (!startDateInput) {
        vscode.window.showErrorMessage('Start date is required');
        return;
      }

      const endDateInput = await vscode.window.showInputBox({
        prompt: 'Enter End Date and Time (YYYY-MM-DD HH:MM:SS)',
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
            const logFiles = getLogFiles(folderPath);
            const totalFiles = logFiles.length;
            let processedFiles = 0;

            for (const file of logFiles) {
              if (token.isCancellationRequested) {
                break;
              }
              await processLogFile(
                file,
                matchedEntries,
                startEpoch,
                endEpoch,
                token
              );
              processedFiles++;
              progress.report({
                increment: (processedFiles / totalFiles) * 100,
                message: `Processing file ${processedFiles} of ${totalFiles}`,
              });
            }

            // Step 4: Sorting and Grouping Results
            matchedEntries.sort((a, b) => a.timestamp - b.timestamp);

            const groupedEntries = groupEntries(matchedEntries);

            displayResults(context, groupedEntries);
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Error during log search: ${err.message}`
            );
          }
        }
      );
    }
  );

  context.subscriptions.push(disposable);
}

function getLogFiles(folderPath: string): string[] {
  const includePatterns: string[] = vscode.workspace
    .getConfiguration('logSearch')
    .get('includePatterns', ['**/*.log']);
  const excludePatterns: string[] = vscode.workspace
    .getConfiguration('logSearch')
    .get('excludePatterns', ['**/node_modules/**']);

  let files: string[] = [];

  function walkDirectory(dir: string) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stats = fs.statSync(itemPath);

      if (stats.isFile()) {
        const relativePath = path.relative(folderPath, itemPath);

        if (
          micromatch.isMatch(relativePath, includePatterns) &&
          !micromatch.isMatch(relativePath, excludePatterns)
        ) {
          files.push(itemPath);
        }
      } else if (stats.isDirectory()) {
        walkDirectory(itemPath);
      }
    }
  }

  walkDirectory(folderPath);

  return files;
}

function parseTimestamp(line: string): number | null {
  const customPatterns = vscode.workspace
    .getConfiguration('logSearch')
    .get<TimestampPattern[]>('customTimestampRegexes', []);

  for (const { pattern, format } of customPatterns) {
    try {
      const regex = new RegExp(pattern);
      const match = line.match(regex);
      if (match) {
        // Use the captured group if available
        const timestampString = match[1] || match[0];

        let dateTime = DateTime.now();

        // Handle UNIX timestamps
        if (format === 'X') {
          dateTime = DateTime.fromSeconds(parseInt(timestampString));
        } else if (format === 'x') {
          dateTime = DateTime.fromMillis(parseInt(timestampString));
        } else {
          dateTime = DateTime.fromFormat(timestampString, format, {
            zone: 'utc',
          });
        }

        if (dateTime.isValid) {
          return dateTime.toMillis();
        }
      }
    } catch (error) {
      console.error(`Invalid regex pattern or date format: ${pattern}`, error);
    }
  }

  // Default parsing: ISO 8601 format
  const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d+Z/;
  const match = line.match(isoRegex);
  if (match) {
    const dateTime = DateTime.fromISO(match[0], { zone: 'utc' });
    if (dateTime.isValid) {
      return dateTime.toMillis();
    }
  }

  return null;
}

function isWithinRange(
  timestamp: number,
  startEpoch: number,
  endEpoch: number
): boolean {
  return timestamp >= startEpoch && timestamp <= endEpoch;
}

function parseLogLevel(line: string): string | null {
  const regex = /\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/i;
  const match = line.match(regex);
  return match ? match[1].toLowerCase() : null; // Return null if no log level is found
}

async function processLogFile(
  filePath: string,
  matchedEntries: LogEntry[],
  startEpoch: number,
  endEpoch: number,
  token: vscode.CancellationToken
) {
  const logLevels: string[] = vscode.workspace
    .getConfiguration('logSearch')
    .get('logLevels', ['INFO', 'WARN', 'ERROR', 'FATAL']);

  const includeAllLevels = logLevels.includes('ALL');

  return new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';
    let lineNumber = 0;

    stream.on('data', (data) => {
      if (token.isCancellationRequested) {
        stream.close();
        resolve();
        return;
      }

      buffer += data;
      let lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        lineNumber++;
        const timestamp = parseTimestamp(line);

        if (
          timestamp !== null &&
          isWithinRange(timestamp, startEpoch, endEpoch)
        ) {
          const logLevel = parseLogLevel(line);
          if (
            includeAllLevels ||
            (logLevel && logLevels.includes(logLevel.toUpperCase()))
          ) {
            matchedEntries.push({ timestamp, line, filePath, lineNumber });
          }
        }
      }
    });

    stream.on('end', () => {
      // Process any remaining buffered data
      if (buffer.length > 0) {
        lineNumber++;
        const timestamp = parseTimestamp(buffer);

        if (
          timestamp !== null &&
          isWithinRange(timestamp, startEpoch, endEpoch)
        ) {
          const logLevel = parseLogLevel(buffer);
          if (
            includeAllLevels ||
            (logLevel && logLevels.includes(logLevel.toUpperCase()))
          ) {
            matchedEntries.push({ timestamp, line: buffer, filePath, lineNumber });
          }
        }
      }
      resolve();
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

// Updated function to group entries by file and sequential ranges
function groupEntries(entries: LogEntry[]) {
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
      // Continue current group
      currentGroup.entries.push(entry);
      currentGroup.endTimestamp = entry.timestamp;
    } else {
      // Start a new group
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

function displayResults(
  context: vscode.ExtensionContext,
  groupedEntries: any[]
) {
  if (groupedEntries.length === 0) {
    vscode.window.showInformationMessage(
      'No logs found in the specified range.'
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'logSearchResults',
    'Log Search Results',
    vscode.ViewColumn.One,
    {
      enableScripts: false, // Scripts are disabled
    }
  );

  const htmlContent = getWebviewContent(groupedEntries);
  panel.webview.html = htmlContent;
}

function getWebviewContent(groupedEntries: any[]): string {
  let contentHtml = '';

  for (const group of groupedEntries) {
    const fileName = path.basename(group.filePath);
    const startTime = DateTime.fromMillis(group.startTimestamp, {
      zone: 'utc',
    }).toFormat('yyyy-LL-dd HH:mm:ss');
    const endTime = DateTime.fromMillis(group.endTimestamp, {
      zone: 'utc',
    }).toFormat('yyyy-LL-dd HH:mm:ss');

    let entriesHtml = '';
    for (const entry of group.entries) {
      const logLevel = parseLogLevel(entry.line) || 'info';
      entriesHtml += `
        <div class="log-entry ${logLevel.toLowerCase()}">
          <span class="line-number">${entry.lineNumber}:</span>
          <span class="log-message">${escapeHtml(entry.line)}</span>
        </div>
      `;
    }

    contentHtml += `
      <details>
        <summary>
          <span class="file-name">${fileName}</span>
          <span class="timestamp-range">(${startTime} - ${endTime})</span>
        </summary>
        ${entriesHtml}
      </details>
    `;
  }

  // Enhanced CSS styling similar to GitHub's dark theme
  const style = `
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #0d1117;
      color: #c9d1d9;
      padding: 20px;
    }
    h1 {
      color: #ffffff;
      font-size: 24px;
    }
    details {
      border: 1px solid #30363d;
      border-radius: 6px;
      margin-bottom: 10px;
      padding: 10px;
      background-color: #161b22;
    }
    summary {
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    .file-name {
      color: #58a6ff;
      font-family: 'Consolas', 'Courier New', monospace;
      margin-right: 10px;
    }
    .timestamp-range {
      color: #8b949e;
    }
    .log-entry {
      padding: 5px 0;
      display: flex;
    }
    .line-number {
      color: #6e7681;
      margin-right: 10px;
    }
    .log-message {
      color: #c9d1d9;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 13px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    /* Remove italics */
    .timestamp-range, .line-number {
      font-style: normal;
    }
    /* Log level highlighting */
    .log-entry.debug .log-message {
      color: #8b949e; /* Gray */
    }
    .log-entry.info .log-message {
      color: #58a6ff; /* Blue */
    }
    .log-entry.warn .log-message {
      color: #d29922; /* Yellow */
    }
    .log-entry.error .log-message {
      color: #f85149; /* Red */
    }
    .log-entry.fatal .log-message {
      color: #d73a49; /* Dark Red */
    }
    details > summary::-webkit-details-marker {
      display: none;
    }
    summary::before {
      content: '▶ ';
      color: #8b949e;
      display: inline-block;
      transition: transform 0.2s ease;
    }
    details[open] > summary::before {
      content: '▼ ';
    }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Log Search Results</title>
<style>
${style}
</style>
</head>
<body>
<h1>Log Search Results</h1>
<div class="log-groups">
  ${contentHtml}
</div>
</body>
</html>`;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function deactivate() {}
