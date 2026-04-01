// test-martingale.js - Run with: node test-martingale.js
class MartingaleTest {
    constructor() {
        this.martingaleMultipliers = [1, 1, 1, 1, 4, 8, 16, 32];
        this.MAX_STEPS = 8;
    }

    resetMartingale(state) {
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        return state;
    }

    advanceMartingale(state) {
        state.losses++;
        if (state.losses >= this.MAX_STEPS) {
            console.log(`   ‚ö†Ô∏è 8 losses reached - Safety reset`);
            this.resetMartingale(state);
            return state;
        }
        let newStep = Math.min(state.losses, this.martingaleMultipliers.length - 1);
        const multiplier = this.martingaleMultipliers[newStep];
        let newAmount = state.baseAmount * multiplier;
        state.step = newStep;
        state.currentAmount = newAmount;
        return state;
    }

    getTradeAmount(state) {
        return state.currentAmount;
    }

    simulateLossSequence(baseAmount, userId, scenario) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Ì∑™ TEST ${scenario}: User ${userId} - Base Amount: ${baseAmount}`);
        console.log(`${'='.repeat(60)}`);
        let state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };
        console.log(`\nÌ≥ä STARTING STATE: Step=${state.step}, Losses=${state.losses}, Amount=${state.currentAmount}\n`);
        for (let i = 1; i <= 8; i++) {
            console.log(`Ì¥Ñ TRADE #${i}:`);
            console.log(`   BEFORE: Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);
            const amount = this.getTradeAmount(state);
            console.log(`   Ì≤∞ Trade Amount: ${amount}`);
            console.log(`   ‚ùå RESULT: LOSS`);
            this.advanceMartingale(state);
            console.log(`   AFTER:  Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);
            console.log(`   ${'-'.repeat(40)}`);
        }
        console.log(`\nÌ≥à FINAL STATE AFTER 8 LOSSES:`);
        console.log(`   Total Losses: ${state.losses}`);
        console.log(`   Final Step: ${state.step}`);
        console.log(`   Final Amount: ${state.currentAmount}`);
        console.log(`   Expected (should be base √ó 32): ${state.baseAmount * 32}`);
        return state;
    }

    simulateWinResetSequence(baseAmount, userId, scenario) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Ì∑™ TEST ${scenario}: User ${userId} - Base Amount: ${baseAmount} - WIN RESET TEST`);
        console.log(`${'='.repeat(60)}`);
        let state = {
            step: 0,
            losses: 0,
            baseAmount: baseAmount,
            currentAmount: baseAmount,
            initialBalance: 1000000
        };
        console.log(`\nÔøΩÔøΩ STARTING STATE: Step=${state.step}, Losses=${state.losses}, Amount=${state.currentAmount}\n`);
        const tests = [
            { lossesToSimulate: 1, expectedMultiplier: 1, expectedAmount: baseAmount },
            { lossesToSimulate: 2, expectedMultiplier: 1, expectedAmount: baseAmount },
            { lossesToSimulate: 3, expectedMultiplier: 1, expectedAmount: baseAmount },
            { lossesToSimulate: 4, expectedMultiplier: 1, expectedAmount: baseAmount },
            { lossesToSimulate: 5, expectedMultiplier: 4, expectedAmount: baseAmount * 4 },
            { lossesToSimulate: 6, expectedMultiplier: 8, expectedAmount: baseAmount * 8 },
            { lossesToSimulate: 7, expectedMultiplier: 16, expectedAmount: baseAmount * 16 }
        ];
        for (const test of tests) {
            state = {
                step: 0,
                losses: 0,
                baseAmount: baseAmount,
                currentAmount: baseAmount,
                initialBalance: 1000000
            };
            console.log(`\n${'‚îÄ'.repeat(50)}`);
            console.log(`Ì≥ä TEST: ${test.lossesToSimulate} loss(es) then WIN`);
            console.log(`${'‚îÄ'.repeat(50)}`);
            for (let i = 1; i <= test.lossesToSimulate; i++) {
                console.log(`   Loss #${i}: Amount=${state.currentAmount}`);
                this.advanceMartingale(state);
            }
            console.log(`\n   Ì≥ç BEFORE WIN: Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);
            console.log(`   ‚úÖ WIN! Resetting martingale...`);
            this.resetMartingale(state);
            console.log(`   Ì≥ç AFTER WIN: Losses=${state.losses}, Step=${state.step}, Amount=${state.currentAmount}`);
            const isCorrect = state.currentAmount === baseAmount;
            console.log(`   ${isCorrect ? '‚úÖ CORRECT' : '‚ùå WRONG'} - Should be: ${baseAmount}`);
        }
        return true;
    }

    runMultipleUsersSimulation() {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Ì∫Ä RUNNING 100 USER SIMULATIONS WITH DIFFERENT BASE AMOUNTS`);
        console.log(`${'='.repeat(60)}`);
        const baseAmounts = [1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000, 75000, 100000, 150000, 200000, 250000, 300000, 350000, 400000, 450000, 500000, 600000, 700000, 800000, 900000, 1000000];
        let allCorrect = true;
        let simulationResults = [];
        for (let i = 0; i < 100; i++) {
            const randomBase = baseAmounts[Math.floor(Math.random() * baseAmounts.length)];
            const userId = `user_${i + 1}`;
            let state = { step: 0, losses: 0, baseAmount: randomBase, currentAmount: randomBase, initialBalance: 10000000 };
            const sequence = [];
            for (let lossNum = 1; lossNum <= 8; lossNum++) {
                const amountBefore = state.currentAmount;
                sequence.push(amountBefore);
                this.advanceMartingale(state);
            }
            const expectedAmounts = [randomBase, randomBase, randomBase, randomBase, randomBase * 4, randomBase * 8, randomBase * 16, randomBase * 32];
            let isCorrect = true;
            for (let j = 0; j < sequence.length; j++) {
                if (sequence[j] !== expectedAmounts[j]) {
                    isCorrect = false;
                    console.log(`‚ùå User ${userId}: Trade ${j + 1} amount ${sequence[j]} should be ${expectedAmounts[j]}`);
                }
            }
            if (!isCorrect) {
                allCorrect = false;
                console.log(`\n‚ùå FAILED: User ${userId} with base ${randomBase}`);
                console.log(`Sequence: ${sequence.join(' ‚Üí ')}`);
                console.log(`Expected: ${expectedAmounts.join(' ‚Üí ')}`);
            }
            simulationResults.push({ userId, baseAmount: randomBase, sequence, isCorrect });
        }
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Ì≥ä SIMULATION SUMMARY`);
        console.log(`${'='.repeat(60)}`);
        const passed = simulationResults.filter(r => r.isCorrect).length;
        const failed = simulationResults.filter(r => !r.isCorrect).length;
        console.log(`‚úÖ Passed: ${passed}/100`);
        console.log(`‚ùå Failed: ${failed}/100`);
        if (passed === 100) console.log(`\nÌæâ PERFECT! All 100 simulations passed!`);
        return allCorrect;
    }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Ì∑™ MARTINGALE CALCULATION TEST SUITE`);
console.log(`${'='.repeat(60)}`);
const tester = new MartingaleTest();
tester.simulateLossSequence(1500, 1, "Small Base (1500)");
tester.simulateLossSequence(200000, 2, "Medium Base (200,000)");
tester.simulateLossSequence(500000, 3, "Large Base (500,000)");
tester.simulateWinResetSequence(100000, 4, "Win Reset");
const allPassed = tester.runMultipleUsersSimulation();
console.log(`\n${'='.repeat(60)}`);
if (allPassed) console.log(`‚úÖ ALL TESTS PASSED - Martingale logic is CORRECT`);
else console.log(`‚ùå SOME TESTS FAILED - Please review the logic`);
console.log(`${'='.repeat(60)}`);
