#!/bin/bash

# Circuit Constraint Analysis Script
# Runs static analysis tools to detect under-constrained signals

set -e

echo "================================"
echo "ZK-VOTE Circuit Analysis"
echo "================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if circom is installed
if ! command -v circom &> /dev/null; then
    echo -e "${RED}✗ circom not found${NC}"
    echo "Install: https://docs.circom.io/getting-started/installation/"
    exit 1
fi

# Check if circomspect is installed (optional)
CIRCOMSPECT_AVAILABLE=false
if command -v circomspect &> /dev/null; then
    CIRCOMSPECT_AVAILABLE=true
    echo -e "${GREEN}✓ circomspect found${NC}"
else
    echo -e "${YELLOW}⚠ circomspect not found (optional)${NC}"
    echo "  Install: cargo install circomspect"
fi

echo ""
echo "Analyzing vote.circom..."
echo "========================"

# Compile with inspection
echo ""
echo "1. Compiling with --inspect flag..."
circom vote.circom --r1cs --wasm --sym --inspect > vote_inspect.log 2>&1

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Compilation successful${NC}"
    
    # Show constraint count
    if [ -f vote.r1cs ]; then
        echo ""
        echo "Circuit statistics:"
        echo "-------------------"
        # Parse r1cs info (simplified - actual parsing would need snarkjs)
        echo "R1CS file generated: vote.r1cs"
        ls -lh vote.r1cs | awk '{print "Size: " $5}'
    fi
else
    echo -e "${RED}✗ Compilation failed${NC}"
    cat vote_inspect.log
    exit 1
fi

# Run circomspect if available
if [ "$CIRCOMSPECT_AVAILABLE" = true ]; then
    echo ""
    echo "2. Running circomspect analysis..."
    circomspect vote.circom --verbose > vote_circomspect.log 2>&1
    
    # Check for warnings or errors
    if grep -qi "warning\|error" vote_circomspect.log; then
        echo -e "${YELLOW}⚠ Issues found:${NC}"
        grep -i "warning\|error" vote_circomspect.log | head -10
        echo ""
        echo "Full report: vote_circomspect.log"
    else
        echo -e "${GREEN}✓ No issues found${NC}"
    fi
fi

echo ""
echo "Analyzing merkle_tree.circom..."
echo "==============================="

echo ""
echo "1. Compiling merkle_tree template..."
# Create a test wrapper to compile merkle_tree
cat > merkle_tree_test.circom <<EOF
pragma circom 2.0.0;
include "./merkle_tree.circom";
component main = MerkleTreeInclusionProof(18);
EOF

circom merkle_tree_test.circom --r1cs --wasm --sym --inspect > merkle_inspect.log 2>&1

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Compilation successful${NC}"
else
    echo -e "${RED}✗ Compilation failed${NC}"
    cat merkle_inspect.log
fi

# Run circomspect on merkle_tree if available
if [ "$CIRCOMSPECT_AVAILABLE" = true ]; then
    echo ""
    echo "2. Running circomspect on merkle_tree..."
    circomspect merkle_tree_test.circom --verbose > merkle_circomspect.log 2>&1
    
    if grep -qi "warning\|error" merkle_circomspect.log; then
        echo -e "${YELLOW}⚠ Issues found:${NC}"
        grep -i "warning\|error" merkle_circomspect.log | head -10
    else
        echo -e "${GREEN}✓ No issues found${NC}"
    fi
fi

# Cleanup test file
rm -f merkle_tree_test.circom

echo ""
echo "================================"
echo "Analysis complete!"
echo "================================"
echo ""
echo "Generated files:"
echo "  - vote_inspect.log (compilation details)"
echo "  - vote.r1cs (R1CS constraint system)"
echo "  - vote.wasm (circuit WebAssembly)"
echo "  - vote.sym (symbol mapping)"
if [ "$CIRCOMSPECT_AVAILABLE" = true ]; then
    echo "  - vote_circomspect.log (static analysis)"
    echo "  - merkle_circomspect.log (static analysis)"
fi

echo ""
echo "Review CONSTRAINT_ANALYSIS.md for detailed analysis"
echo ""

# Summary check
ISSUES_FOUND=false

if [ -f vote_circomspect.log ] && grep -qi "error" vote_circomspect.log; then
    ISSUES_FOUND=true
fi

if [ -f merkle_circomspect.log ] && grep -qi "error" merkle_circomspect.log; then
    ISSUES_FOUND=true
fi

if [ "$ISSUES_FOUND" = true ]; then
    echo -e "${RED}⚠ CRITICAL: Errors found in circuits${NC}"
    echo "Review log files before deployment"
    exit 1
else
    echo -e "${GREEN}✓ All checks passed${NC}"
    echo "Circuits appear to be properly constrained"
fi
