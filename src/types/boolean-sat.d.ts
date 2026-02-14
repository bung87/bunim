declare module 'boolean-sat' {
  /**
   * Solve a SAT problem
   * @param numVars - Number of variables
   * @param clauses - Array of clauses, each clause is an array of literals (positive or negative integers)
   * @returns Array of boolean assignments (index 0 is null, index 1 is variable 1, etc.) or false if unsatisfiable
   */
  function satSolve(numVars: number, clauses: number[][]): (boolean | null)[] | false;

  export default satSolve;
}
