export interface LogEntry {
    timestamp: number; // Changed to number (epoch time)
    line: string;
    filePath: string;
    lineNumber: number;
  }
  