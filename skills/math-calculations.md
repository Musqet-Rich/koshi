---
name: math-calculations
description: Run mathematical calculations using a shell environment
triggers: [calculate, math, compute, arithmetic, formula, equation, convert, percentage, "how much", sum, average]
tools: [Bash]
---

## How to handle calculations

1. Parse the user's math request into a concrete expression
2. Use `Bash` to run the calculation — prefer `python3 -c` for precision and complex math:
   - Simple: `python3 -c "print(42 * 1.15)"`
   - Complex: `python3 -c "import math; print(math.sqrt(144))"`
   - Financial: `python3 -c "print(round(1000 * (1 + 0.05) ** 10, 2))"`
3. Return the result with a brief explanation of what was computed
4. For unit conversions, show the formula used

## Tips
- Always use `python3 -c` over `bc` for floating-point accuracy
- For statistics or data work, use `import statistics` or `import numpy` if available
- Show your work — include the expression so the user can verify

## Common patterns
- "What's 15% of 230?" -> `python3 -c "print(230 * 0.15)"`
- "Convert 72F to Celsius" -> `python3 -c "print(round((72 - 32) * 5/9, 2))"`
- "Compound interest on $5000 at 4% for 3 years" -> `python3 -c "print(round(5000 * (1.04 ** 3), 2))"`
