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
            vscode.window.showErrorMessage(`Error during log search: ${err.message}`);
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
        const timestampString = match[1] || match[0];
        let dateTime = DateTime.now();

        if (format === 'X') {
          dateTime = DateTime.fromSeconds(parseInt(timestampString));
        } else if (format === 'x') {
          dateTime = DateTime.fromMillis(parseInt(timestampString));
        } else {
          dateTime = DateTime.fromFormat(timestampString, format, { zone: 'utc' });
        }

        if (dateTime.isValid) {
          return dateTime.toMillis();
        }
      }
    } catch (error) {
      console.error(`Invalid regex pattern or date format: ${pattern}`, error);
    }
  }

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

function extractTimestampFromJson(jsonObject: any): number | null {
  const timestampFields: string[] = vscode.workspace
    .getConfiguration('logSearch')
    .get('timestampFields', ['created', 'modified']); // Default to 'created' and 'modified'

  for (const field of timestampFields) {
    if (jsonObject.hasOwnProperty(field)) {
      const timestamp = DateTime.fromISO(jsonObject[field], { zone: 'utc' });
      if (timestamp.isValid) {
        return timestamp.toMillis();
      }
    }
  }

  return null;  // No valid timestamp found in JSON
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
  return match ? match[1].toLowerCase() : null;
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
    let jsonBuffer = '';
    let insideJson = false;
    let openBracesCount = 0;

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

        // Check if we are entering a JSON object
        if (line.trim().startsWith('{')) {
          insideJson = true;
          openBracesCount = 1; // Start counting braces
          jsonBuffer += line; // Add the current line to the buffer
          continue;
        }

        // If inside JSON, accumulate lines and check for closing braces
        if (insideJson) {
          jsonBuffer += '\n' + line;
          openBracesCount += (line.match(/{/g) || []).length; // Count opening braces
          openBracesCount -= (line.match(/}/g) || []).length; // Count closing braces

          if (openBracesCount === 0) {
            // We have found the closing brace of the JSON object
            insideJson = false;
            try {
              const jsonObject = JSON.parse(jsonBuffer);
              jsonBuffer = ''; // Clear the buffer

              // Extract timestamp from JSON and filter logs
              const timestamp = extractTimestampFromJson(jsonObject);
              if (timestamp && isWithinRange(timestamp, startEpoch, endEpoch)) {
                matchedEntries.push({ timestamp, line: JSON.stringify(jsonObject), filePath, lineNumber });
              }
            } catch (error) {
              console.error('Failed to parse JSON:', error);
              jsonBuffer = ''; // Reset buffer if parsing fails
            }
          }
          continue;
        }

        // Handle regular log lines (non-JSON)
        const timestamp = parseTimestamp(line);
        if (timestamp !== null && isWithinRange(timestamp, startEpoch, endEpoch)) {
          const logLevel = parseLogLevel(line);
          if (includeAllLevels || (logLevel && logLevels.includes(logLevel.toUpperCase()))) {
            matchedEntries.push({ timestamp, line, filePath, lineNumber });
          }
        }
      }
    });

    stream.on('end', () => {
      if (jsonBuffer.length > 0) {
        try {
          const jsonObject = JSON.parse(jsonBuffer);
          const timestamp = extractTimestampFromJson(jsonObject);
          if (timestamp && isWithinRange(timestamp, startEpoch, endEpoch)) {
            matchedEntries.push({ timestamp, line: JSON.stringify(jsonObject), filePath, lineNumber });
          }
        } catch (error) {
          console.error('Failed to parse remaining JSON buffer:', error);
        }
      }
      resolve();
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}


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

function displayResults(
  context: vscode.ExtensionContext,
  groupedEntries: any[]
) {
  if (groupedEntries.length === 0) {
    vscode.window.showInformationMessage('No logs found in the specified range.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'logSearchResults',
    'Log Search Results',
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  const htmlContent = getWebviewContent(groupedEntries);
  panel.webview.html = htmlContent;
}

function getWebviewContent(groupedEntries: any[]): string {
  const keywords: string[] = vscode.workspace.getConfiguration('logSearch').get('keywords', []);
  const highlightColor = '#ff66cc'; // Pink color for highlighting keywords

  let contentHtml = '';

  // Function to highlight keywords in the log message
  const highlightKeywords = (text: string) => {
    if (keywords.length > 0) {
      const keywordRegex = new RegExp(`(${keywords.join('|')})`, 'gi');
      return text.replace(keywordRegex, `<strong style="color:${highlightColor};">$1</strong>`);
    }
    return text;
  };

  for (const group of groupedEntries) {
    const fileName = path.basename(group.filePath);
    const startTime = DateTime.fromMillis(group.startTimestamp, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss');
    const endTime = DateTime.fromMillis(group.endTimestamp, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss');

    let entriesHtml = '';
    for (const entry of group.entries) {
      const logLevel = parseLogLevel(entry.line) || 'info';

      // Try to format the line as JSON and highlight it
      let formattedLogMessage;
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
        <div class="log-entry ${logLevel.toLowerCase()}">
          <span class="line-number">${entry.lineNumber}:</span>
          ${jsonBadge} <!-- JSON badge only if it's a JSON log -->
          <span class="log-message">${formattedLogMessage}</span>
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

  const style = `
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #2d2d2d;
      color: #d4d4d4;
      padding: 10px;
      font-size: 12px; /* Smaller font size */
    }
    details {
      border: 1px solid #444;
      border-radius: 5px;
      margin-bottom: 8px;
      padding: 8px;
      background-color: #333;
    }
    summary {
      font-size: 14px;
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
      font-style: italic;
    }
    .log-entry {
      padding: 2px 0; /* Reduce spacing */
      display: flex;
      align-items: flex-start;
    }
    .line-number {
      color: #888;
      margin-right: 5px;
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
      margin: 0; /* Remove default margin on pre */
    }
    strong {
      font-weight: bold;
      color: ${highlightColor}; /* Pink for highlighted keywords */
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
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}



export function deactivate() {}
