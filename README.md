# Log Search Extension

An extension for Visual Studio Code that allows you to search and analyze log files within a specified date range. It supports custom timestamp patterns, log level filtering, and displays results in an organized, readable format with log level highlighting.

## Features

- **Search Logs by Date Range**: Specify a start and end date/time to filter log entries within that range.
- **Custom Timestamp Patterns**: Add custom regex patterns and date formats to parse various timestamp formats in your logs.
- **Log Level Filtering**: Filter logs based on log levels such as DEBUG, INFO, WARN, ERROR, and FATAL.
- **Grouped Log Entries**: Logs are grouped by file and timestamp ranges, displayed in an expandable/collapsible format.
- **Log Level Highlighting**: Different log levels are highlighted with distinct colors for easy identification.
- **User-Friendly Interface**: Utilizes VSCode's settings UI for configuration and provides a readable output styled similar to GitHub's dark theme.

## Installation

1. **Clone or Download the Extension Repository**

   ```bash
   git clone https://github.com/your-username/log-search-extension.git
   ```

2. **Navigate to the Extension Directory**

   ```bash
   cd log-search-extension
   ```

3. **Install Dependencies**

   ```bash
   npm install
   ```

4. **Compile the Extension**

   ```bash
   npm run compile
   ```

5. **Launch the Extension**

   - Open the project in Visual Studio Code.
   - Press `F5` to start the extension in a new Extension Development Host window.

## Usage Instructions

### 1. Activate the Extension

- Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on macOS).
- Type and select `Log Search: Search Logs by Date Range`.

### 2. Select Log Folder

- A dialog will appear prompting you to select the folder containing your log files.
- Navigate to and select the desired folder.

### 3. Enter Date Range

- **Start Date and Time**: Enter the start date and time in the format `YYYY-MM-DD HH:MM:SS`.
- **End Date and Time**: Enter the end date and time in the same format.

### 4. View Search Progress

- A progress notification will appear, showing the search status.
- You can cancel the search at any time if needed.

### 5. View Results

- Once the search is complete, the results will be displayed in a new tab.
- Logs are grouped by file and timestamp ranges.
- Click on a group to expand or collapse it.
- Each log entry is displayed with its line number and message.
- Log levels are highlighted with different colors:

  - **DEBUG**: Gray
  - **INFO**: Blue
  - **WARN**: Yellow
  - **ERROR**: Red
  - **FATAL**: Dark Red

## Configuration

### Custom Timestamp Patterns

To handle various timestamp formats in your logs, you can add custom timestamp regex patterns and their corresponding date formats.

#### Add Custom Timestamp Patterns via Settings UI

1. **Open VSCode Settings**

   - Go to `File` > `Preferences` > `Settings` (or use `Ctrl+,`).

2. **Search for Extension Settings**

   - Type `Log Search Extension` in the search bar.

3. **Add Custom Timestamp Regexes**

   - Under `Log Search Extension Configuration`, find `Log Search: Custom Timestamp Regexes`.
   - Click `Add Item` to add a new pattern.
   - **Pattern**: Enter the regex pattern to match your timestamp.
   - **Format**: Enter the date format corresponding to the regex pattern, following [Luxon date format tokens](https://moment.github.io/luxon/#/formatting?id=table-of-tokens).

#### Example Patterns

Here's an example of how to add patterns:

```json
{
  "logSearch.customTimestampRegexes": [
    {
      "pattern": "\\[(\\d{2}/[A-Za-z]{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4})\\]",
      "format": "dd/MMM/yyyy:HH:mm:ss ZZZZ"
    },
    {
      "pattern": "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+",
      "format": "yyyy-MM-dd HH:mm:ss.SSSS"
    }
  ]
}
```

### Log Level Filtering

You can specify which log levels to include in the search results.

#### Configure Log Levels

1. **Open VSCode Settings**.
2. **Search for `Log Search: Log Levels`**.
3. **Select Desired Log Levels**:

   - Options: `ALL`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.
   - Example to include all levels:

     ```json
     "logSearch.logLevels": [
       "ALL"
     ]
     ```

### Include and Exclude Patterns

Specify glob patterns to include or exclude certain files.

#### Include Patterns

- **Setting**: `logSearch.includePatterns`
- **Default**: `["**/*.log"]`
- **Example**:

  ```json
  "logSearch.includePatterns": [
    "*.log",
    "*.txt"
  ]
  ```

#### Exclude Patterns

- **Setting**: `logSearch.excludePatterns`
- **Default**: `["**/node_modules/**"]`
- **Example**:

  ```json
  "logSearch.excludePatterns": [
    "**/node_modules/**",
    "**/archive/**"
  ]
  ```

## Settings Overview

Below is a summary of all available settings:

### `logSearch.includePatterns`

- **Type**: Array of strings
- **Description**: Glob patterns to include files in the search.
- **Default**: `["**/*.log"]`

### `logSearch.excludePatterns`

- **Type**: Array of strings
- **Description**: Glob patterns to exclude files from the search.
- **Default**: `["**/node_modules/**"]`

### `logSearch.logLevels`

- **Type**: Array of strings
- **Options**: `ALL`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`
- **Description**: Log levels to include in the search.
- **Default**: `["INFO", "WARN", "ERROR", "FATAL"]`

### `logSearch.customTimestampRegexes`

- **Type**: Array of objects
- **Description**: Custom timestamp regex patterns and their date formats.
- **Default**: `[]`
- **Object Structure**:

  ```json
  {
    "pattern": "Your regex pattern here",
    "format": "Corresponding date format"
  }
  ```

## Example `settings.json`

Here is an example `settings.json` with custom configurations:

```json
{
  "logSearch.logLevels": [
    "ALL"
  ],
  "logSearch.includePatterns": [
    "*.log",
    "*.txt"
  ],
  "logSearch.customTimestampRegexes": [
    {
      "pattern": "\\[(\\d{2}/[A-Za-z]{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4})\\]",
      "format": "dd/MMM/yyyy:HH:mm:ss ZZZZ"
    },
    {
      "pattern": "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+",
      "format": "yyyy-MM-dd HH:mm:ss.SSSS"
    },
    {
      "pattern": "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
      "format": "yyyy-MM-dd'T'HH:mm:ss'Z'"
    }
  ]
}
```

## Development

### Prerequisites

- **Node.js**: Ensure you have Node.js installed (version 14 or higher recommended).
- **Visual Studio Code**: Install the latest version.

### Setup

1. **Clone the Repository**

   ```bash
   git clone https://github.com/your-username/log-search-extension.git
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Compile the Extension**

   ```bash
   npm run compile
   ```

4. **Launch Extension for Development**

   - Open the project in Visual Studio Code.
   - Press `F5` to run the extension in a new Extension Development Host window.

### Building the Extension

- To build the extension for distribution, you can use the `vsce` tool:

  ```bash
  npm install -g vsce
  vsce package
  ```

- This will generate a `.vsix` file that can be installed in VSCode.

## Known Issues

- **Large Log Files**: Processing very large log files may impact performance. Consider narrowing the date range or excluding large files if necessary.
- **Custom Patterns**: Incorrect regex patterns or date formats in `customTimestampRegexes` can lead to parsing errors. Ensure patterns are valid and test them with sample logs.

## Troubleshooting

- **No Logs Found**: If no logs are found, check that your date range is correct and that your `includePatterns` and `excludePatterns` settings are appropriately configured.
- **Timestamp Parsing Errors**: Ensure that your custom timestamp patterns match the timestamps in your logs and that the date formats are correct according to Luxon's formatting tokens.

## Contributing

Contributions are welcome! Please submit issues and pull requests via the [GitHub repository](https://github.com/neledov/vscode-log-filter).

### Steps to Contribute

1. **Fork the Repository**
2. **Create a Feature Branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Commit Your Changes**
4. **Push to Your Fork**

   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create a Pull Request**

## License

This project is licensed under the [MIT License]

## Acknowledgments

- **Luxon**: A powerful library for working with dates and times.
- **Visual Studio Code Extension API**: For providing the tools to create this extension.

---

**Happy Logging!** If you have any questions or need assistance, feel free to open an issue on GitHub or contact the maintainer.
