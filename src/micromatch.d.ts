declare module 'micromatch' {
    function micromatch(
      list: string[],
      patterns: string | string[],
      options?: any
    ): string[];
  
    namespace micromatch {
      function isMatch(
        str: string,
        patterns: string | string[],
        options?: any
      ): boolean;
      // Add more declarations as needed
    }
  
    export = micromatch;
  }
  