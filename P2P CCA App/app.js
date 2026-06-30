// ────────────────────────────────────────────────────────────────────────
// SECTION 1: Constant Model ID and State Management
// ────────────────────────────────────────────────────────────────────────

const MODEL_ID = 'claude-3-5-haiku-20241022'; // Target Haiku model for narration

// In-memory session state (no localStorage/sessionStorage used for this demo)
const state = {
  transactions: [],     // All generated transactions (clean + injected)
  exceptions: [],       // Detected exception cases
  reconciliation: {},   // Planted vs Detected stats
  activeFilter: 'all',  // Filter: 'all' | 'flagged' | 'clean' | test_id
  searchQuery: '',      // Current search query
  selectedExceptionId: null, // Selected exception for narration drill-down
  narrationData: null,  // Claude response (summary + narrations per exception)
  isNarrating: false,   // Narration loading state
  narrationError: null, // Narration error
  apiKey: (typeof localStorage !== 'undefined') ? (localStorage.getItem('cao_api_key') || '') : '',           // Claude API Key
  apiEndpoint: (typeof localStorage !== 'undefined') ? (localStorage.getItem('cao_proxy_url') || 'https://api.anthropic.com/v1/messages') : 'https://api.anthropic.com/v1/messages', // Claude API Endpoint or Cloudflare Worker Proxy URL
  chatHistory: [],      // Conversational history for rule assistant chat
  isChatting: false,    // Chat response loading state
  plantedCount: {
    test_1: 0, test_2: 0, test_3: 0, test_4: 0, test_5: 0,
    test_6: 0, test_7: 0, test_8: 0, test_9: 0, test_10: 0
  },
  enabledTests: {
    test_1: true, test_2: true, test_3: true, test_4: true, test_5: true,
    test_6: true, test_7: true, test_8: true, test_9: true, test_10: true
  },
  baselineSize: 1500
};

// Test definitions & descriptions
const TEST_DEFINITIONS = {
  test_1: { id: 'test_1', name: 'Split POs below approval threshold', desc: '≥3 records, same vendor, rolling 7 days, each < $10k, sum ≥ $10k.' },
  test_2: { id: 'test_2', name: 'Round-dollar invoices', desc: 'Invoice amount is an exact multiple of $1,000 and ≥ $5,000.' },
  test_3: { id: 'test_3', name: 'Out-of-hours / weekend posting', desc: 'Record created on a weekend or outside 07:00–19:00 local time.' },
  test_4: { id: 'test_4', name: 'Segregation-of-duties conflict', desc: 'The approver on a record equals the PO raiser.' },
  test_5: { id: 'test_5', name: 'Duplicate payments (exact)', desc: 'Two or more transactions sharing identical vendor, amount, and invoice number.' },
  test_6: { id: 'test_6', name: 'Fuzzy near-duplicates', desc: 'Same vendor and amount within ±3 days, or same vendor/amount with invoice number off by 1 digit.' },
  test_7: { id: 'test_7', name: 'Broken 3-way match', desc: 'A payment status of "paid" but with no PO number (null po_no).' },
  test_8: { id: 'test_8', name: 'Payment to non-master vendor', desc: 'A transaction for a vendor ID that is not present in the approved vendor master.' },
  test_9: { id: 'test_9', name: 'Vendor bank-detail change shortly before payment', desc: 'A transaction account number that differs from the vendor\'s master account details.' },
  test_10: { id: 'test_10', name: 'Sequential invoice numbers from one vendor', desc: 'Three or more invoices for the same vendor that are perfectly sequential (e.g. INV-1001, 1002, 1003).' }
};

// ────────────────────────────────────────────────────────────────────────
// SECTION 2: Static Pools & Approved Vendor Master
// ────────────────────────────────────────────────────────────────────────

// Approved Vendor Master (30 entries)
const VENDOR_MASTER = {
  'V001': { vendor_id: 'V001', vendor_name: 'Apex Solutions Inc', account_number: 'US892003112' },
  'V002': { vendor_id: 'V002', vendor_name: 'Beacon Logistics', account_number: 'US112004921' },
  'V003': { vendor_id: 'V003', vendor_name: 'Crown Distributors', account_number: 'US440192837' },
  'V004': { vendor_id: 'V004', vendor_name: 'Delta Industrial Supplies', account_number: 'US773910293' },
  'V005': { vendor_id: 'V005', vendor_name: 'Echo Consulting Group', account_number: 'US229384710' },
  'V006': { vendor_id: 'V006', vendor_name: 'Falcon Engineering', account_number: 'US554019283' },
  'V007': { vendor_id: 'V007', vendor_name: 'Genesis Office Supplies', account_number: 'US991827364' },
  'V008': { vendor_id: 'V008', vendor_name: 'Horizon Utilities', account_number: 'US334918273' },
  'V009': { vendor_id: 'V009', vendor_name: 'Integrity Facilities', account_number: 'US661029384' },
  'V010': { vendor_id: 'V010', vendor_name: 'Jupiter Tech Partners', account_number: 'US882938471' },
  'V011': { vendor_id: 'V011', vendor_name: 'Keystone Capital', account_number: 'US123847192' },
  'V012': { vendor_id: 'V012', vendor_name: 'Liberty Security Systems', account_number: 'US987362514' },
  'V013': { vendor_id: 'V013', vendor_name: 'Meridian Global Services', account_number: 'US543210987' },
  'V014': { vendor_id: 'V014', vendor_name: 'Nova Packaging', account_number: 'US678901234' },
  'V015': { vendor_id: 'V015', vendor_name: 'Oasis Water Systems', account_number: 'US246801357' },
  'V016': { vendor_id: 'V016', vendor_name: 'Pinnacle Staffing', account_number: 'US135792468' },
  'V017': { vendor_id: 'V017', vendor_name: 'Quantum Electronics', account_number: 'US951357246' },
  'V018': { vendor_id: 'V018', vendor_name: 'Redwood Software Corp', account_number: 'US753159842' },
  'V019': { vendor_id: 'V019', vendor_name: 'Summit Construction', account_number: 'US864201357' },
  'V020': { vendor_id: 'V020', vendor_name: 'Titan Freight Services', account_number: 'US975318642' },
  'V021': { vendor_id: 'V021', vendor_name: 'Universal Cleaning Corp', account_number: 'US246809753' },
  'V022': { vendor_id: 'V022', vendor_name: 'Vanguard Marketing', account_number: 'US135790864' },
  'V023': { vendor_id: 'V023', vendor_name: 'Westward Energy Co', account_number: 'US753198642' },
  'V024': { vendor_id: 'V024', vendor_name: 'Xenon Laboratories', account_number: 'US951357864' },
  'V025': { vendor_id: 'V025', vendor_name: 'Yorkshire Paper Corp', account_number: 'US846201937' },
  'V026': { vendor_id: 'V026', vendor_name: 'Zenith Design Studios', account_number: 'US927481029' },
  'V027': { vendor_id: 'V027', vendor_name: 'Alliance Insurance Ltd', account_number: 'US582910482' },
  'V028': { vendor_id: 'V028', vendor_name: 'Blue Ribbon Catering', account_number: 'US374829104' },
  'V029': { vendor_id: 'V029', vendor_name: 'Compass Travel Agency', account_number: 'US294810293' },
  'V030': { vendor_id: 'V030', vendor_name: 'Direct Mail Solutions', account_number: 'US910293847' }
};

const APPROVER_POOL = ['U001', 'U002', 'U003', 'U004', 'U005', 'U006', 'U007', 'U008'];
const RAISER_POOL = ['U009', 'U010', 'U011', 'U012', 'U013', 'U014', 'U015', 'U016'];

// Vendors reserved for clean baseline to prevent cross-contamination with test rules
const CLEAN_VENDORS = ['V019', 'V020', 'V021', 'V022', 'V023', 'V024', 'V025', 'V026', 'V027', 'V028', 'V029', 'V030'];

// Expand VENDOR_MASTER and CLEAN_VENDORS with more clean vendors to lower transaction density
// and prevent Split PO (T1) and Sequential (T10) false positives in high-volume baselines.
for (let i = 31; i <= 75; i++) {
  const id = `V0${i}`;
  VENDOR_MASTER[id] = {
    vendor_id: id,
    vendor_name: `Clean Vendor Partners ${i}`,
    account_number: `US${Math.floor(100000000 + Math.random() * 900000000)}`
  };
  CLEAN_VENDORS.push(id);
}

let txnCounter = 1;
function generateNextTxnId() {
  const num = String(txnCounter++).padStart(6, '0');
  return `TX${num}`;
}

// Helper to generate a random number within a range
function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

// Helper to pick random item from array
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 3: Safe Clean Base Generator (No False Positives)
// ────────────────────────────────────────────────────────────────────────

function generateCleanBase(size) {
  txnCounter = 1;
  const list = [];
  const baseDate = new Date();
  const vendors = CLEAN_VENDORS;
  
  // Create shell rows with even distribution of vendors
  for (let i = 0; i < size; i++) {
    const vendorId = vendors[i % vendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    list.push({
      txn_id: '',
      date: '',
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: '',
      po_no: '',
      amount: 0,
      approver: '',
      po_raiser: '',
      created_ts: '',
      account_number: vendor.account_number,
      status: 'paid',
      flags: []
    });
  }
  
  // Group by vendor to space dates and assign amounts safely
  const vendorTxns = {};
  list.forEach(t => {
    if (!vendorTxns[t.vendor_id]) vendorTxns[t.vendor_id] = [];
    vendorTxns[t.vendor_id].push(t);
  });
  
  Object.keys(vendorTxns).forEach(vendorId => {
    const txns = vendorTxns[vendorId];
    const K = txns.length;
    
    txns.forEach((t, idx) => {
      // Space dates evenly across a 360-day window to prevent dense clustering
      const daysOffset = 360 - Math.round((350 / (K + 1)) * (idx + 1)) - Math.floor(randRange(0, 2));
      const date = new Date(baseDate);
      date.setDate(baseDate.getDate() - daysOffset);
      
      // Shift weekend to Monday/Tuesday
      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0) date.setDate(date.getDate() + 1);
      if (dayOfWeek === 6) date.setDate(date.getDate() + 2);
      
      // Daytime hours: 08:00 to 17:00
      const hour = Math.floor(randRange(8, 17));
      const minute = Math.floor(randRange(0, 59));
      const second = Math.floor(randRange(0, 59));
      date.setHours(hour, minute, second);
      
      t.date = date.toISOString().split('T')[0];
      t.created_ts = date.toISOString();
      
      // Amount generation:
      // - 90% small payments ($100 to $3,000) - guarantees Split PO sum < $10k
      // - 10% large payments ($12,000 to $25,000) - excluded from Split PO since they are >= $10k
      let amount = 0;
      if (Math.random() < 0.90) {
        amount = parseFloat((randRange(100, 3000) + randRange(0.01, 0.99)).toFixed(2));
      } else {
        amount = parseFloat((randRange(12000, 25000) + randRange(0.01, 0.99)).toFixed(2));
      }
      
      // Prevent round numbers
      if (Math.round(amount) % 1000 === 0) {
        amount += 5.25;
      }
      t.amount = amount;
      
      // Disjoint approver/raiser pools
      t.approver = pickRandom(APPROVER_POOL);
      t.po_raiser = pickRandom(RAISER_POOL);
      
      // Unique random invoice & PO numbers
      t.invoice_no = `INV-${10000 + txnCounter + idx + Math.floor(randRange(0, 5000))}`;
      t.po_no = `PO-${50000 + txnCounter + idx + Math.floor(randRange(0, 5000))}`;
    });
    
    txnCounter += K;
  });
  
  // Re-sort in date order and assign sequential transaction IDs
  list.sort((a, b) => new Date(a.date) - new Date(b.date));
  txnCounter = 1;
  list.forEach(t => {
    t.txn_id = generateNextTxnId();
  });
  
  // Post-generation fix-up pass as a final safety check
  fixCleanBaseFalsePositives(list);
  
  return list;
}

function fixCleanBaseFalsePositives(txns) {
  let attempts = 0;
  let hasFPs = true;
  
  while (hasFPs && attempts < 5) {
    hasFPs = false;
    attempts++;
    
    // 1. Fix Split POs
    const test1Exceptions = DETECTORS.test_1(txns);
    if (test1Exceptions.length > 0) {
      hasFPs = true;
      test1Exceptions.forEach(ex => {
        ex.rows.forEach((row, idx) => {
          if (idx > 0) {
            // Shift date by 10 days to break the 7-day clustering
            const d = new Date(row.created_ts);
            d.setDate(d.getDate() + 10);
            
            // Adjust day of week if weekend
            const dayOfWeek = d.getDay();
            if (dayOfWeek === 0) d.setDate(d.getDate() + 1);
            if (dayOfWeek === 6) d.setDate(d.getDate() + 2);
            
            row.date = d.toISOString().split('T')[0];
            row.created_ts = d.toISOString();
          }
        });
      });
      // Sort again after changing dates
      txns.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // 2. Fix Accidental Exact Duplicates
    const test5Exceptions = DETECTORS.test_5(txns);
    if (test5Exceptions.length > 0) {
      hasFPs = true;
      test5Exceptions.forEach(ex => {
        ex.rows.slice(1).forEach(row => {
          // Re-generate unique invoice number
          row.invoice_no = `INV-FIX-${Math.floor(randRange(10000, 99999))}`;
        });
      });
    }
    
    // 3. Fix Accidental Fuzzy Duplicates
    const test6Exceptions = DETECTORS.test_6(txns);
    if (test6Exceptions.length > 0) {
      hasFPs = true;
      test6Exceptions.forEach(ex => {
        if (ex.rows[1]) {
          const d = new Date(ex.rows[1].created_ts);
          d.setDate(d.getDate() + 5);
          
          const dayOfWeek = d.getDay();
          if (dayOfWeek === 0) d.setDate(d.getDate() + 1);
          if (dayOfWeek === 6) d.setDate(d.getDate() + 2);
          
          ex.rows[1].date = d.toISOString().split('T')[0];
          ex.rows[1].created_ts = d.toISOString();
        }
      });
      txns.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // 4. Fix Accidental Sequential Invoices
    const test10Exceptions = DETECTORS.test_10(txns);
    if (test10Exceptions.length > 0) {
      hasFPs = true;
      test10Exceptions.forEach(ex => {
        ex.rows.slice(1).forEach(row => {
          row.invoice_no = `INV-FIX-${Math.floor(randRange(10000, 99999))}`;
        });
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 4: Case Builders (Planting Anomalies)
// ────────────────────────────────────────────────────────────────────────

// Helper: ensure dates are weekday daytime to prevent triggering out-of-hours test on other cases
function adjustToWeekdayAndDaytime(date, hour = 10) {
  const day = date.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0) date.setDate(date.getDate() + 1);
  if (day === 6) date.setDate(date.getDate() + 2);
  date.setHours(hour, 0, 0);
  return date;
}

const CASE_BUILDERS = {
  // Test 1: Split POs
  test_1: (transactions, index) => {
    // Pick a random approved vendor dedicated to Test 1
    const testVendors = ['V001', 'V002'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    // Set a base date spaced out to prevent merging clusters
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() - (10 + index * 10));
    
    // Build 3 transactions within 4 days (e.g. D, D+2, D+4)
    const offsets = [0, 2, 4];
    // Add unique offset to amount based on index to prevent fuzzy duplicate match across cases
    const amounts = [9500 + index, 9300 + index, 9700 + index]; // each < $10k, sum >= $10k
    
    for (let k = 0; k < 3; k++) {
      const date = new Date(baseDate);
      date.setDate(baseDate.getDate() + offsets[k]);
      adjustToWeekdayAndDaytime(date, 10 + k);
      
      const invoice_no = `INV-SP-${1000 + index * 100 + k}`;
      const poNum = 70000 + index * 100;
      
      transactions.push({
        txn_id: generateNextTxnId(),
        date: date.toISOString().split('T')[0],
        vendor_id: vendorId,
        vendor_name: vendor.vendor_name,
        invoice_no: invoice_no,
        po_no: `PO-SP-${poNum}`, // same PO reference prefix to hint split
        amount: amounts[k],
        approver: pickRandom(APPROVER_POOL),
        po_raiser: pickRandom(RAISER_POOL),
        created_ts: date.toISOString(),
        account_number: vendor.account_number,
        status: 'paid',
        flags: [],
        _planted_test: 'test_1'
      });
    }
  },

  // Test 2: Round-dollar invoices
  test_2: (transactions, index) => {
    // Dedicated Test 2 vendors
    const testVendors = ['V003', 'V004'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    adjustToWeekdayAndDaytime(date, 11);
    
    // Round amount >= 5000
    const roundAmounts = [5000, 10000, 15000, 20000, 25000];
    const amount = pickRandom(roundAmounts);
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: `INV-RD-${3000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: `PO-RD-${50000 + index * 100}`,
      amount: amount,
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: vendor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_2'
    });
  },

  // Test 3: Out-of-hours posting (intentionally no adjustment)
  test_3: (transactions, index) => {
    // Dedicated Test 3 vendors
    const testVendors = ['V005', 'V006'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    
    // Alternate between weekend and late night
    if (index % 2 === 0) {
      // Weekend: Saturday
      const day = date.getDay();
      const diff = 6 - day;
      date.setDate(date.getDate() + diff);
      date.setHours(14, 30, 0);
    } else {
      // Out of hours: 02:45 AM on weekday
      const day = date.getDay();
      if (day === 0) date.setDate(date.getDate() + 1);
      if (day === 6) date.setDate(date.getDate() + 2);
      date.setHours(2, 45, 0);
    }
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: `INV-OH-${4000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: `PO-OH-${60000 + index * 100}`,
      amount: parseFloat((randRange(500, 4500) + 0.35).toFixed(2)),
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: vendor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_3'
    });
  },

  // Test 4: Segregation of duties
  test_4: (transactions, index) => {
    // Dedicated Test 4 vendors
    const testVendors = ['V007', 'V008'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    adjustToWeekdayAndDaytime(date, 13);
    
    const sameUser = pickRandom(APPROVER_POOL); // Approver is PO Raiser
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: `INV-SD-${5000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: `PO-SD-${70000 + index * 100}`,
      amount: parseFloat((randRange(1000, 6000) + 0.12).toFixed(2)),
      approver: sameUser,
      po_raiser: sameUser,
      created_ts: date.toISOString(),
      account_number: vendor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_4'
    });
  },

  // Test 5: Duplicate Payments (exact) - Relational (with vendor isolation)
  test_5: (transactions, index) => {
    // Pick a random clean row as anchor from transactions
    const cleanRows = transactions.filter(t => !t._planted_test && !t._used_as_anchor);
    if (cleanRows.length === 0) return;
    const anchor = pickRandom(cleanRows);
    anchor._used_as_anchor = true;
    
    // Assign a dedicated vendor for Test 5 to isolate it
    const testVendors = ['V009', 'V010'];
    const dedicatedVendorId = testVendors[index % testVendors.length];
    const dedicatedVendor = VENDOR_MASTER[dedicatedVendorId];
    
    // Convert anchor to the dedicated vendor details
    anchor.vendor_id = dedicatedVendorId;
    anchor.vendor_name = dedicatedVendor.vendor_name;
    anchor.account_number = dedicatedVendor.account_number;
    
    // Force amount to be under $4,500 so duplicates never sum to >= $10k (avoiding Split PO triggers)
    anchor.amount = parseFloat((randRange(1000, 4500) + 0.15).toFixed(2));
    
    // Assign a spaced out invoice number to prevent matching Levenshtein checks on other cases
    anchor.invoice_no = `INV-DP-${12000 + index * 100}`;
    anchor.po_no = `PO-DP-${12000 + index * 100}`;
    
    // Enforce weekday & daytime and spaced date for anchor
    const anchorDate = new Date();
    anchorDate.setDate(anchorDate.getDate() - (10 + index * 10));
    adjustToWeekdayAndDaytime(anchorDate, 10);
    anchor.date = anchorDate.toISOString().split('T')[0];
    anchor.created_ts = anchorDate.toISOString();
    
    // Create clone
    const date = new Date(anchor.date);
    date.setDate(date.getDate() + 1); // dated 1 day later
    adjustToWeekdayAndDaytime(date, 10);
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: anchor.vendor_id,
      vendor_name: anchor.vendor_name,
      invoice_no: anchor.invoice_no,
      po_no: anchor.po_no,
      amount: anchor.amount,
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: anchor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_5'
    });
  },

  // Test 6: Fuzzy duplicates - Relational (with vendor isolation)
  test_6: (transactions, index) => {
    const cleanRows = transactions.filter(t => !t._planted_test && !t._used_as_anchor);
    if (cleanRows.length === 0) return;
    const anchor = pickRandom(cleanRows);
    anchor._used_as_anchor = true;
    
    // Assign a dedicated vendor for Test 6 to isolate it
    const testVendors = ['V011', 'V012'];
    const dedicatedVendorId = testVendors[index % testVendors.length];
    const dedicatedVendor = VENDOR_MASTER[dedicatedVendorId];
    
    // Convert anchor to dedicated vendor
    anchor.vendor_id = dedicatedVendorId;
    anchor.vendor_name = dedicatedVendor.vendor_name;
    anchor.account_number = dedicatedVendor.account_number;
    
    // Force amount to be under $4,500 so duplicates never sum to >= $10k (avoiding Split PO triggers)
    anchor.amount = parseFloat((randRange(1000, 4500) + 0.16).toFixed(2));
    
    // Assign spaced out invoice base
    anchor.invoice_no = `INV-FZ-${13000 + index * 100}A`;
    anchor.po_no = `PO-FZ-${13000 + index * 100}`;
    
    // Enforce weekday & daytime and spaced date for anchor
    const anchorDate = new Date();
    anchorDate.setDate(anchorDate.getDate() - (10 + index * 10));
    adjustToWeekdayAndDaytime(anchorDate, 11);
    anchor.date = anchorDate.toISOString().split('T')[0];
    anchor.created_ts = anchorDate.toISOString();
    
    const date = new Date(anchor.date);
    
    // Always shift date by 2 days and alter last character.
    // E.g., INV-FZ-13100A -> INV-FZ-13100B (differ by single character change).
    // This satisfies the fuzzy duplicate rules and guarantees it is never an exact duplicate.
    date.setDate(date.getDate() + 2);
    const invoice_no = anchor.invoice_no.slice(0, -1) + 'B';
    adjustToWeekdayAndDaytime(date, 11);
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: anchor.vendor_id,
      vendor_name: anchor.vendor_name,
      invoice_no: invoice_no,
      po_no: anchor.po_no,
      amount: anchor.amount,
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: anchor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_6'
    });
  },

  // Test 7: Broken 3-way match
  test_7: (transactions, index) => {
    // Dedicated Test 7 vendors
    const testVendors = ['V013', 'V014'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    adjustToWeekdayAndDaytime(date, 14);
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: `INV-BM-${7000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: null, // No PO Reference!
      amount: parseFloat((randRange(1500, 8000) + 0.50).toFixed(2)),
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: vendor.account_number,
      status: 'paid',
      flags: [],
      _planted_test: 'test_7'
    });
  },

  // Test 8: Non-master vendor (naturally isolated by V9xxx vendor id)
  test_8: (transactions, index) => {
    const fakeVendorId = `V9${String(100 + index * 10)}`;
    const fakeVendorName = pickRandom([
      'Phoenix Consulting Corp', 'Global Logistics Partners', 'Ironwood Contracting',
      'Starlight Event Agency', 'Northern Fuel Depot', 'Apex Commercial Cleaners'
    ]) + ' (Unapproved)';
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    adjustToWeekdayAndDaytime(date, 15);
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: fakeVendorId,
      vendor_name: fakeVendorName,
      invoice_no: `INV-NM-${8000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: `PO-NM-${90000 + index * 100}`,
      amount: parseFloat((randRange(500, 5000) + 0.99).toFixed(2)),
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: 'US' + Math.floor(randRange(100000000, 999999999)),
      status: 'paid',
      flags: [],
      _planted_test: 'test_8'
    });
  },

  // Test 9: Bank detail change
  test_9: (transactions, index) => {
    // Dedicated Test 9 vendors
    const testVendors = ['V015', 'V016'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const date = new Date();
    date.setDate(date.getDate() - (10 + index * 5));
    adjustToWeekdayAndDaytime(date, 16);
    
    // Modify account number (e.g. change last 3 digits)
    const alteredAccount = vendor.account_number.slice(0, -3) + '999';
    
    transactions.push({
      txn_id: generateNextTxnId(),
      date: date.toISOString().split('T')[0],
      vendor_id: vendorId,
      vendor_name: vendor.vendor_name,
      invoice_no: `INV-BC-${9000 + index * 100 + Math.floor(randRange(0, 90))}`,
      po_no: `PO-BC-${40000 + index * 100}`,
      amount: parseFloat((randRange(2000, 9000) + 0.88).toFixed(2)),
      approver: pickRandom(APPROVER_POOL),
      po_raiser: pickRandom(RAISER_POOL),
      created_ts: date.toISOString(),
      account_number: alteredAccount, // altered bank account number
      status: 'paid',
      flags: [],
      _planted_test: 'test_9'
    });
  },

  // Test 10: Sequential invoices
  test_10: (transactions, index) => {
    // Dedicated Test 10 vendors
    const testVendors = ['V017', 'V018'];
    const vendorId = testVendors[index % testVendors.length];
    const vendor = VENDOR_MASTER[vendorId];
    
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() - (10 + index * 10)); // space out sequential dates
    
    const startInvoice = 25000 + (index * 100); // ensures sequential runs are spaced far apart
    
    // Build 3 sequential transactions
    for (let k = 0; k < 3; k++) {
      const date = new Date(baseDate);
      date.setDate(baseDate.getDate() + k); // successive dates
      adjustToWeekdayAndDaytime(date, 14);
      
      transactions.push({
        txn_id: generateNextTxnId(),
        date: date.toISOString().split('T')[0],
        vendor_id: vendorId,
        vendor_name: vendor.vendor_name,
        invoice_no: `INV-${startInvoice + k}`, // consecutive invoice numbers
        po_no: `PO-SQ-${30000 + index * 100}`,
        amount: parseFloat((randRange(500, 2000) + 0.44).toFixed(2)),
        approver: pickRandom(APPROVER_POOL),
        po_raiser: pickRandom(RAISER_POOL),
        created_ts: date.toISOString(),
        account_number: vendor.account_number,
        status: 'paid',
        flags: [],
        _planted_test: 'test_10'
      });
    }
  }
};

// ────────────────────────────────────────────────────────────────────────
// SECTION 5: Exception Detectors (Deterministic Logic)
// ────────────────────────────────────────────────────────────────────────

// Helper: check if ISO string represents weekend or out of office
function checkOutOfHours(tsString) {
  const d = new Date(tsString);
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return true;
  const hour = d.getHours();
  if (hour < 7 || hour >= 19) return true;
  return false;
}

// Levenshtein distance
function calcLevenshtein(s1, s2) {
  if (!s1 || !s2) return 999;
  const m = s1.length, n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + 1);
      }
    }
  }
  return dp[m][n];
}

// Extract numeric suffix from invoice numbers (e.g., INV-12345 -> 12345)
function getInvoiceSuffix(invoiceNo) {
  if (!invoiceNo) return null;
  const match = invoiceNo.match(/INV-(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

const DETECTORS = {
  // Test 1: Split POs
  test_1: (txns) => {
    const threshold = 10000;
    const exceptions = [];
    const vendorGroups = {};
    
    // Group transactions by vendor
    txns.forEach(t => {
      if (!vendorGroups[t.vendor_id]) vendorGroups[t.vendor_id] = [];
      vendorGroups[t.vendor_id].push(t);
    });
    
    Object.keys(vendorGroups).forEach(vendorId => {
      const vendorTxns = [...vendorGroups[vendorId]];
      // Sort by date ascending
      vendorTxns.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      const flaggedTxns = new Set();
      const groupsFound = [];
      
      for (let i = 0; i < vendorTxns.length; i++) {
        const windowTxns = [];
        const startDate = new Date(vendorTxns[i].date);
        
        for (let j = i; j < vendorTxns.length; j++) {
          const currDate = new Date(vendorTxns[j].date);
          const diffDays = (currDate - startDate) / (1000 * 60 * 60 * 24);
          
          if (diffDays <= 7) {
            // Only examine individual items less than threshold
            if (vendorTxns[j].amount < threshold) {
              windowTxns.push(vendorTxns[j]);
            }
          } else {
            break;
          }
        }
        
        if (windowTxns.length >= 3) {
          const sum = windowTxns.reduce((acc, t) => acc + t.amount, 0);
          if (sum >= threshold) {
            groupsFound.push([...windowTxns]);
            windowTxns.forEach(t => flaggedTxns.add(t));
          }
        }
      }
      
      // Deduplicate split groups that overlap
      const mergedGroups = [];
      groupsFound.forEach(group => {
        let merged = false;
        for (let mg of mergedGroups) {
          // If they share any transaction, merge them
          if (group.some(t => mg.some(m => m.txn_id === t.txn_id))) {
            group.forEach(t => {
              if (!mg.some(m => m.txn_id === t.txn_id)) mg.push(t);
            });
            merged = true;
            break;
          }
        }
        if (!merged) {
          mergedGroups.push(group);
        }
      });
      
      mergedGroups.forEach(group => {
        group.sort((a, b) => new Date(a.date) - new Date(b.date));
        const sum = group.reduce((acc, t) => acc + t.amount, 0);
        
        exceptions.push({
          test_id: 'test_1',
          test_name: TEST_DEFINITIONS.test_1.name,
          vendor_name: group[0].vendor_name,
          txn_ids: group.map(t => t.txn_id),
          summary_details: `${group.length} split payments totalling $${sum.toLocaleString('en-US', {minimumFractionDigits: 2})}`,
          rows: group
        });
      });
    });
    
    return exceptions;
  },

  // Test 2: Round-dollar invoices
  test_2: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      if (t.amount >= 5000 && t.amount % 1000 === 0) {
        exceptions.push({
          test_id: 'test_2',
          test_name: TEST_DEFINITIONS.test_2.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Round-dollar payment of $${t.amount.toLocaleString('en-US')}`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 3: Out-of-hours posting
  test_3: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      if (checkOutOfHours(t.created_ts)) {
        const timeStr = new Date(t.created_ts).toLocaleTimeString('en-US', {hour12: true, hour: '2-digit', minute:'2-digit'});
        const dayStr = new Date(t.created_ts).toLocaleDateString('en-US', {weekday: 'long'});
        exceptions.push({
          test_id: 'test_3',
          test_name: TEST_DEFINITIONS.test_3.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Posted on a ${dayStr} at ${timeStr}`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 4: Segregation of duties
  test_4: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      if (t.approver && t.po_raiser && t.approver === t.po_raiser) {
        exceptions.push({
          test_id: 'test_4',
          test_name: TEST_DEFINITIONS.test_4.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Invoice approved and PO raised by same user: ${t.approver}`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 5: Duplicate payments (exact)
  test_5: (txns) => {
    const exceptions = [];
    const groups = {};
    
    // Group by vendor + amount + invoice_no
    txns.forEach(t => {
      const key = `${t.vendor_id}|${t.amount}|${t.invoice_no}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
    
    Object.keys(groups).forEach(key => {
      const group = groups[key];
      if (group.length >= 2) {
        // Sort by txn_id or date to determine original vs duplicates
        group.sort((a, b) => new Date(a.date) - new Date(b.date) || a.txn_id.localeCompare(b.txn_id));
        
        // The first one is the "original", subsequent ones are duplicates
        // But for reporting, we bundle them into a single exception case
        const duplicateRows = group.slice(1);
        
        exceptions.push({
          test_id: 'test_5',
          test_name: TEST_DEFINITIONS.test_5.name,
          vendor_name: group[0].vendor_name,
          // We flag only the duplicate rows to keep reconciliation 1:1
          txn_ids: duplicateRows.map(r => r.txn_id),
          summary_details: `Exact duplicate payment of $${group[0].amount.toLocaleString('en-US', {minimumFractionDigits: 2})} on invoice ${group[0].invoice_no}`,
          rows: group // but pass the whole group so the auditor can see original + copy
        });
      }
    });
    
    return exceptions;
  },

  // Test 6: Fuzzy duplicates
  test_6: (txns) => {
    const exceptions = [];
    const vendorGroups = {};
    
    // Group transactions by vendor
    txns.forEach(t => {
      if (!vendorGroups[t.vendor_id]) vendorGroups[t.vendor_id] = [];
      vendorGroups[t.vendor_id].push(t);
    });
    
    Object.keys(vendorGroups).forEach(vendorId => {
      const vendorTxns = [...vendorGroups[vendorId]];
      vendorTxns.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      const matchedTxnIds = new Set();
      
      for (let i = 0; i < vendorTxns.length; i++) {
        for (let j = i + 1; j < vendorTxns.length; j++) {
          const rowA = vendorTxns[i];
          const rowB = vendorTxns[j];
          
          // Exclude exact duplicates which are handled by Test 5
          if (rowA.amount === rowB.amount && rowA.invoice_no === rowB.invoice_no) continue;
          
          if (matchedTxnIds.has(rowB.txn_id)) continue;
          
          const timeDiff = Math.abs(new Date(rowB.date) - new Date(rowA.date)) / (1000 * 60 * 60 * 24);
          
          let isFuzzy = false;
          let reason = '';
          
          if (rowA.amount === rowB.amount && timeDiff <= 3) {
            isFuzzy = true;
            reason = `Identical amount $${rowA.amount.toLocaleString()} paid within ${Math.ceil(timeDiff)} days`;
          } else if (rowA.amount === rowB.amount && calcLevenshtein(rowA.invoice_no, rowB.invoice_no) === 1) {
            isFuzzy = true;
            reason = `Identical amount paid on near-identical invoice numbers: ${rowA.invoice_no} vs ${rowB.invoice_no}`;
          }
          
          if (isFuzzy) {
            matchedTxnIds.add(rowB.txn_id);
            exceptions.push({
              test_id: 'test_6',
              test_name: TEST_DEFINITIONS.test_6.name,
              vendor_name: rowA.vendor_name,
              txn_ids: [rowB.txn_id], // flag the secondary row
              summary_details: reason,
              rows: [rowA, rowB] // show both rows in detail
            });
          }
        }
      }
    });
    
    return exceptions;
  },

  // Test 7: Broken 3-way match
  test_7: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      if (t.status === 'paid' && !t.po_no) {
        exceptions.push({
          test_id: 'test_7',
          test_name: TEST_DEFINITIONS.test_7.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Payment completed without a valid Purchase Order (PO)`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 8: Non-master vendor
  test_8: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      if (!VENDOR_MASTER[t.vendor_id]) {
        exceptions.push({
          test_id: 'test_8',
          test_name: TEST_DEFINITIONS.test_8.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Vendor ID ${t.vendor_id} is not registered in the approved vendor master`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 9: Bank detail change
  test_9: (txns) => {
    const exceptions = [];
    txns.forEach(t => {
      const master = VENDOR_MASTER[t.vendor_id];
      // Only check approved master vendors (missing vendors handled by test_8)
      if (master && t.account_number !== master.account_number) {
        exceptions.push({
          test_id: 'test_9',
          test_name: TEST_DEFINITIONS.test_9.name,
          vendor_name: t.vendor_name,
          txn_ids: [t.txn_id],
          summary_details: `Payment sent to bank account ${t.account_number} (master registered is ${master.account_number})`,
          rows: [t]
        });
      }
    });
    return exceptions;
  },

  // Test 10: Sequential invoices
  test_10: (txns) => {
    const exceptions = [];
    const vendorGroups = {};
    
    txns.forEach(t => {
      if (!vendorGroups[t.vendor_id]) vendorGroups[t.vendor_id] = [];
      vendorGroups[t.vendor_id].push(t);
    });
    
    Object.keys(vendorGroups).forEach(vendorId => {
      const vendorTxns = vendorGroups[vendorId];
      
      // Parse invoice suffixes and filter
      const parsed = vendorTxns
        .map(t => ({ txn: t, suffix: getInvoiceSuffix(t.invoice_no) }))
        .filter(item => item.suffix !== null)
        .sort((a, b) => a.suffix - b.suffix);
      
      let currentRun = [];
      
      for (let i = 0; i < parsed.length; i++) {
        if (currentRun.length === 0) {
          currentRun.push(parsed[i]);
        } else {
          const lastSuffix = currentRun[currentRun.length - 1].suffix;
          if (parsed[i].suffix === lastSuffix + 1) {
            currentRun.push(parsed[i]);
          } else if (parsed[i].suffix === lastSuffix) {
            // identical suffix (already handled by duplicate checks, skip)
            continue;
          } else {
            // Break in sequence: evaluate run
            if (currentRun.length >= 3) {
              const runTxns = currentRun.map(item => item.txn);
              exceptions.push({
                test_id: 'test_10',
                test_name: TEST_DEFINITIONS.test_10.name,
                vendor_name: runTxns[0].vendor_name,
                // flag only secondary items to keep count 1:1 with planted runs
                txn_ids: runTxns.slice(1).map(t => t.txn_id),
                summary_details: `${runTxns.length} sequential invoices (${currentRun[0].suffix} to ${currentRun[currentRun.length - 1].suffix})`,
                rows: runTxns
              });
            }
            currentRun = [parsed[i]];
          }
        }
      }
      
      // Check last run
      if (currentRun.length >= 3) {
        const runTxns = currentRun.map(item => item.txn);
        exceptions.push({
          test_id: 'test_10',
          test_name: TEST_DEFINITIONS.test_10.name,
          vendor_name: runTxns[0].vendor_name,
          txn_ids: runTxns.slice(1).map(t => t.txn_id),
          summary_details: `${runTxns.length} sequential invoices (${currentRun[0].suffix} to ${currentRun[currentRun.length - 1].suffix})`,
          rows: runTxns
        });
      }
    });
    
    return exceptions;
  }
};

// Main execution function
function runDetectionPipeline() {
  // Clear previous flags
  state.transactions.forEach(t => t.flags = []);
  
  state.exceptions = [];
  
  // Run each enabled test
  Object.keys(TEST_DEFINITIONS).forEach(testId => {
    if (state.enabledTests[testId]) {
      const testExceptions = DETECTORS[testId](state.transactions);
      
      testExceptions.forEach((ex, idx) => {
        // Assign robust unique ID to this exception case
        ex.id = `EX-${testId}-${idx + 1}`;
        
        // Add flags to transaction records
        ex.txn_ids.forEach(txnId => {
          const row = state.transactions.find(t => t.txn_id === txnId);
          if (row && !row.flags.includes(testId)) {
            row.flags.push(testId);
          }
        });
        
        state.exceptions.push(ex);
      });
      
      // Reconcile
      const planted = state.plantedCount[testId];
      const detected = testExceptions.length;
      state.reconciliation[testId] = {
        planted: planted,
        detected: detected,
        match: planted === detected,
        active: true
      };
    } else {
      state.reconciliation[testId] = {
        planted: 0,
        detected: 0,
        match: true,
        active: false
      };
    }
  });
  
  // Sort exceptions so that they display cleanly
  state.exceptions.sort((a, b) => a.test_id.localeCompare(b.test_id));
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 6: Claude API Client (Anthropic direct browser call)
// ────────────────────────────────────────────────────────────────────────

async function fetchClaudeNarrative() {
  if (state.exceptions.length === 0) {
    state.narrationData = {
      summary: 'No exceptions were detected in this run. Continuous controls monitoring indicates 100% adherence to P2P business rules.',
      narrations: {}
    };
    return;
  }
  
  state.isNarrating = true;
  state.narrationError = null;
  renderDashboard(); // Show spinner
  
  // Group exceptions by test_id for a clean context to send to Claude
  const groupedExceptions = {};
  state.exceptions.forEach(ex => {
    if (!groupedExceptions[ex.test_id]) {
      groupedExceptions[ex.test_id] = {
        test_id: ex.test_id,
        test_name: ex.test_name,
        cases_count: 0,
        txn_count: 0,
        anomalies: []
      };
    }
    groupedExceptions[ex.test_id].cases_count++;
    groupedExceptions[ex.test_id].txn_count += ex.rows.length;
    groupedExceptions[ex.test_id].anomalies.push({
      vendor_name: ex.vendor_name,
      details: ex.summary_details,
      amount: ex.amount,
      invoice_no: ex.invoice_no
    });
  });
  
  const exceptionsPayload = Object.values(groupedExceptions);
  
  const systemPrompt = `You are a Continuous Controls Monitoring AI auditor assistant. Your job is to narrate Procure-to-Pay (P2P) transaction exception findings in plain, professional language.
  
  You will receive a JSON list of exceptions grouped by control test rule.
  You MUST return ONLY a raw JSON object with the following exact structure:
  {
    "summary": "A 2-3 sentence overall summary of this audit run, noting the volume of exceptions, where they cluster, and what the reviewer should address first.",
    "narrations": {
      "test_1": "A single cohesive paragraph explaining what was found for this test, why it constitutes an anomaly, and how it occurred. Cite specific vendor names, counts of occurrences, and total amounts involved.",
      "test_3": "..."
    }
  }

  CONSTRAINTS:
  1. Do NOT write any conversational text, no markdown code blocks, no backticks (e.g. \`\`\`json), no introduction, no sign-off. Return ONLY the valid parseable JSON.
  2. Cite exact figures, counts, and names from the input records.
  3. Do NOT assert fraud as a definite fact. Use objective, defensive audit terminology like "consistent with", "warrants review", "suggests bypass of controls", "potential duplicate".
  4. Ensure every test_id in the input list has a corresponding narration entry.
  5. Limit the narration for each test_id to exactly one clear, concise paragraph.`;

  try {
    const headers = {
      'content-type': 'application/json'
    };
    
    // Set appropriate Anthropic bypass headers if calling the official API endpoint directly
    if (state.apiEndpoint.includes('api.anthropic.com')) {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    
    if (state.apiKey) {
      headers['x-api-key'] = state.apiKey;
    }
    
    const response = await fetch(state.apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 1200,
        temperature: 0.1,
        system: systemPrompt,
        messages: [
          { role: 'user', content: JSON.stringify(exceptionsPayload, null, 2) }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    const rawText = result.content[0].text;
    
    // Parse response defensively
    state.narrationData = cleanAndParseJson(rawText);
  } catch (err) {
    console.error('Narration failed:', err);
    state.narrationError = err.message;
    // Fallback narration on failure so UI remains usable
    state.narrationData = generateMockNarrations(state.exceptions);
  } finally {
    state.isNarrating = false;
    renderDashboard();
  }
}

// Clean markdown code blocks and parse JSON
function cleanAndParseJson(text) {
  let clean = text.trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(clean.trim());
}

// Local fallback builder to guarantee a functional dashboard even if offline or key fails
function generateMockNarrations(exceptions) {
  const narrations = {};
  
  // Group exceptions by test_id first
  const groups = {};
  exceptions.forEach(ex => {
    if (!groups[ex.test_id]) groups[ex.test_id] = [];
    groups[ex.test_id].push(ex);
  });
  
  Object.keys(groups).forEach(testId => {
    const list = groups[testId];
    const vendors = [...new Set(list.map(ex => ex.vendor_name))];
    const vendorListText = vendors.length > 2 
      ? `${vendors.slice(0, 2).join(', ')} and others`
      : vendors.join(' and ');
      
    let narrative = '';
    switch (testId) {
      case 'test_1': {
        const totalAmount = list.reduce((sum, ex) => sum + ex.rows.reduce((s, r) => s + r.amount, 0), 0);
        narrative = `Detected ${list.length} split Purchase Order cases affecting vendor(s) ${vendorListText}, totaling $${totalAmount.toLocaleString('en-US', {maximumFractionDigits:2})}. Transactions were split into multiple sub-$10,000 invoices within a rolling 7-day window to bypass the formal PO bidding limit.`;
        break;
      }
      case 'test_2':
        narrative = `Found ${list.length} round-dollar invoice instances matching vendor(s) ${vendorListText}. These payments (such as multiples of $5,000) are statistically anomalous for standard business ledger processing and suggest manual intervention or unvouched adjustments.`;
        break;
      case 'test_3':
        narrative = `Identified ${list.length} out-of-hours posting exceptions for vendor(s) ${vendorListText}. These postings were entered either during weekends or late nights (between 18:00 and 07:59), representing potential security overrides or critical process bypasses.`;
        break;
      case 'test_4':
        narrative = `Flagged ${list.length} Segregation of Duties violations affecting vendor(s) ${vendorListText}. Transactions show PO raiser and invoice approver user accounts are identical, breaching basic check-and-balance policy parameters.`;
        break;
      case 'test_5':
        narrative = `Detected ${list.length} exact duplicate invoice entries processed for vendor(s) ${vendorListText}. Multiple transactions share identical invoice numbers, vendor IDs, and amounts, representing duplicate payment execution risks.`;
        break;
      case 'test_6':
        narrative = `Discovered ${list.length} fuzzy duplicate payment instances for vendor(s) ${vendorListText}. Invoice pairs share identical amounts within a 3-day window or have invoice numbers differing by a single digit (Levenshtein distance = 1).`;
        break;
      case 'test_7':
        narrative = `Identified ${list.length} broken 3-way match transactions affecting vendor(s) ${vendorListText}. These invoice payments were processed directly without a valid PO reference number, violating standard P2P compliance matching rules.`;
        break;
      case 'test_8':
        narrative = `Detected ${list.length} payments made to unapproved vendors (${vendorListText}) who are missing from the approved Vendor Master Directory. This indicates onboarding control breakdowns.`;
        break;
      case 'test_9':
        narrative = `Flagged ${list.length} bank detail changes for vendor(s) ${vendorListText}. Payment account numbers used on these invoices do not match the registered routing profile on file in the Vendor Master, indicating potential bank account manipulation.`;
        break;
      case 'test_10':
        narrative = `Discovered ${list.length} sequential invoice runs submitted by vendor(s) ${vendorListText}. Consecutive invoice numbers issued within close dates suggest structured billing patterns to bypass audit thresholds.`;
        break;
      default:
        narrative = `Flagged ${list.length} anomalies for vendor(s) ${vendorListText} under rule ${testId}. Audit validation recommended.`;
    }
    narrations[testId] = narrative;
  });
  
  return {
    summary: `Continuous Controls Monitoring executed over ${state.transactions.length} items. Detected compliance exceptions across ${Object.keys(groups).length} control rules. Priority review recommended for Segregation-of-Duties and bank detail mismatches. (Narrative generated via local fallback).`,
    narrations: narrations
  };
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 6B: P2P Rule Assistant Chat Engine
// ────────────────────────────────────────────────────────────────────────

async function handleSendChatMessage() {
  const inputEl = document.getElementById('chat-input-text');
  if (!inputEl) return;
  const question = inputEl.value.trim();
  if (!question) return;
  
  // Clear input
  inputEl.value = '';
  
  // Append user message to history
  appendChatMessage('user', question);
  
  // If we are already waiting for a response, return
  if (state.isChatting) return;
  state.isChatting = true;
  
  // Add loading placeholder to chat history
  const loadingId = appendChatLoadingPlaceholder();
  
  try {
    // Build context
    const exceptionsSummary = state.exceptions.map(ex => ({
      id: ex.id,
      test_id: ex.test_id,
      test_name: ex.test_name,
      vendor_name: ex.vendor_name,
      details: ex.summary_details,
      amount: ex.amount,
      invoice_no: ex.invoice_no,
      txn_ids: ex.txn_ids
    }));
    
    const chatSystemPrompt = `You are a Continuous Controls Monitoring Chat Assistant. Your job is to answer questions about the current P2P audit run, the transaction ledger, the active test rules, and detected exceptions.
    
    Here is the context of the current audit run:
    - Total transactions in ledger: ${state.transactions.length}
    - Total detected exceptions: ${state.exceptions.length}
    - Clean transactions: ${state.transactions.length - state.exceptions.reduce((acc, ex) => acc + ex.rows.length, 0)}
    - Active filter: ${state.activeFilter}
    
    Active Rules & Limits:
    1. Split POs (T1): Groups of >=3 transactions for same vendor in 7 days, each < $10k but sum >= $10k.
    2. Round Invoices (T2): Invoices with round amounts (e.g. multiples of $5k) and >= $5,000.
    3. Out-of-Hours (T3): Posted on Saturday/Sunday or between 18:00 and 07:59.
    4. Segregation of Duties (T4): PO raiser and invoice approver are identical user IDs.
    5. Exact Duplicates (T5): Same vendor ID, amount, and invoice number.
    6. Fuzzy Duplicates (T6): Same vendor and amount within +/- 3 days or invoice numbers differing by Levenshtein distance 1.
    7. Broken 3-Way Match (T7): Invoices missing PO Reference (null PO).
    8. Non-Master Vendor (T8): Vendor ID starts with 'V9' (unapproved).
    9. Bank Detail Change (T9): Account number used differs from approved vendor bank profile.
    10. Sequential Invoices (T10): >=3 consecutive invoice numbers in close dates.
    
    The detected exceptions JSON payload:
    ${JSON.stringify(exceptionsSummary, null, 2)}
    
    You are talking to the Chief Audit Officer. Answer their questions clearly, citing exact vendors, invoice numbers, amounts, and transaction IDs where appropriate. Use bullet points or HTML tables for structured data.
    If asked to filter or show specific rows, note that they can click the "Filter Ledger" drill-down button on the findings cards, or use the ledger filters/search bar.
    Keep answers professional, audit-focused, and concise.`;
    
    // Map state.chatHistory to Anthropic messages format
    // We only keep the last 6 messages (3 turns) to fit context and keep API calls lightweight
    const recentHistory = state.chatHistory.slice(-6).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.text
    }));
    
    // Add current question if not already in recentHistory
    if (recentHistory.length === 0 || recentHistory[recentHistory.length - 1].content !== question) {
      recentHistory.push({ role: 'user', content: question });
    }
    
    const headers = {
      'content-type': 'application/json'
    };
    if (state.apiEndpoint.includes('api.anthropic.com')) {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    if (state.apiKey) {
      headers['x-api-key'] = state.apiKey;
    }
    
    const response = await fetch(state.apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 800,
        temperature: 0.2,
        system: chatSystemPrompt,
        messages: recentHistory
      })
    });
    
    removeChatLoadingPlaceholder(loadingId);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    const assistantReply = result.content[0].text;
    
    appendChatMessage('assistant', assistantReply);
  } catch (err) {
    console.error('Chat failed:', err);
    removeChatLoadingPlaceholder(loadingId);
    appendChatMessage('assistant', `Error: I failed to contact the model API. Details: ${err.message}. Please verify your API Key and Proxy URL settings.`);
  } finally {
    state.isChatting = false;
  }
}

function sendSuggestion(text) {
  const inputEl = document.getElementById('chat-input-text');
  if (inputEl) {
    inputEl.value = text;
    handleSendChatMessage();
  }
}

function appendChatMessage(role, text) {
  // Save to state history
  state.chatHistory.push({ role, text });
  
  const historyEl = document.getElementById('chat-history');
  if (!historyEl) return;
  
  const msgEl = document.createElement('div');
  msgEl.className = `chat-message ${role}`;
  msgEl.style.fontSize = '0.8rem';
  msgEl.style.padding = '0.5rem 0.75rem';
  msgEl.style.borderRadius = 'var(--radius-sm)';
  msgEl.style.maxWidth = '85%';
  msgEl.style.lineHeight = '1.4';
  
  if (role === 'user') {
    msgEl.style.backgroundColor = 'var(--accent-primary)';
    msgEl.style.color = '#ffffff';
    msgEl.style.alignSelf = 'flex-end';
    msgEl.textContent = text;
  } else if (role === 'assistant') {
    msgEl.style.backgroundColor = 'rgba(255,255,255,0.03)';
    msgEl.style.border = '1px solid rgba(255,255,255,0.05)';
    msgEl.style.color = 'var(--text-color)';
    msgEl.style.alignSelf = 'flex-start';
    msgEl.innerHTML = formatChatReply(text);
  } else {
    // system message
    msgEl.style.backgroundColor = 'rgba(99,102,241,0.05)';
    msgEl.style.borderLeft = '2px solid var(--accent-secondary)';
    msgEl.style.color = 'var(--accent-secondary)';
    msgEl.style.alignSelf = 'flex-start';
    msgEl.innerHTML = text;
  }
  
  historyEl.appendChild(msgEl);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function appendChatLoadingPlaceholder() {
  const historyEl = document.getElementById('chat-history');
  if (!historyEl) return null;
  
  const loadingId = 'chat-loading-' + Date.now();
  const msgEl = document.createElement('div');
  msgEl.id = loadingId;
  msgEl.className = 'chat-message assistant loading';
  msgEl.style.fontSize = '0.8rem';
  msgEl.style.padding = '0.5rem 0.75rem';
  msgEl.style.borderRadius = 'var(--radius-sm)';
  msgEl.style.backgroundColor = 'rgba(255,255,255,0.03)';
  msgEl.style.border = '1px solid rgba(255,255,255,0.05)';
  msgEl.style.color = 'var(--text-muted)';
  msgEl.style.alignSelf = 'flex-start';
  msgEl.innerHTML = `
    <div style="display: flex; gap: 4px; align-items: center;">
      <span style="font-style: italic;">Auditor is thinking</span>
      <span class="dot" style="animation: pulse 1s infinite alternate;">.</span>
      <span class="dot" style="animation: pulse 1s infinite alternate; animation-delay: 0.2s;">.</span>
      <span class="dot" style="animation: pulse 1s infinite alternate; animation-delay: 0.4s;">.</span>
    </div>
  `;
  historyEl.appendChild(msgEl);
  historyEl.scrollTop = historyEl.scrollHeight;
  return loadingId;
}

function removeChatLoadingPlaceholder(id) {
  if (!id) return;
  const el = document.getElementById(id);
  el?.remove();
}

function formatChatReply(text) {
  let html = escHtml(text);
  // Replace double asterisks with bold tags
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Replace newlines with line breaks
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

// Bind globally for suggestion buttons and enter key inside index.html
window.sendSuggestion = sendSuggestion;
window.handleSendChatMessage = handleSendChatMessage;

// ────────────────────────────────────────────────────────────────────────
// SECTION 7: UI Rendering & Event Handling
// ────────────────────────────────────────────────────────────────────────

function initApp() {
  setupEventListeners();
  renderSetupScreen();
}

function setupEventListeners() {
  // Navigation
  document.getElementById('nav-setup-btn').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('setup');
  });
  
  document.getElementById('nav-dash-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.transactions.length === 0) {
      alert('Please generate data first!');
      return;
    }
    showScreen('dashboard');
  });
  
  // Settings Button
  document.getElementById('nav-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-endpoint-input').value = state.apiEndpoint;
    document.getElementById('settings-modal').classList.add('active');
  });
  
  document.getElementById('settings-close').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('active');
  });
  
  document.getElementById('settings-save').addEventListener('click', () => {
    state.apiEndpoint = document.getElementById('settings-endpoint-input').value.trim() || 'https://api.anthropic.com/v1/messages';
    
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cao_proxy_url', state.apiEndpoint);
    }
    
    document.getElementById('settings-modal').classList.remove('active');
  });
  
  // Setup control panel options
  document.getElementById('baseline-select').addEventListener('change', (e) => {
    state.baselineSize = parseInt(e.target.value, 10);
  });
  
  // Generate Action
  document.getElementById('generate-btn').addEventListener('click', handleGenerateScenario);
  
  // Search Ledger
  document.getElementById('ledger-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    renderLedgerTable();
  });
  
  // Filter Buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      
      const button = e.currentTarget;
      button.classList.add('active');
      state.activeFilter = button.dataset.filter;
      
      // Clear drill-down exception selection when manual filters are clicked
      state.selectedExceptionId = null;
      renderClaudeNarration(); // Reset highlighted state in narratives list
      
      renderLedgerTable();
    });
  });
  
  // Clear selections drill down link
  document.getElementById('clear-selections-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.selectedExceptionId = null;
    renderClaudeNarration();
    renderLedgerTable();
  });
  
  // Collapsible legend toggle
  const legendToggle = document.getElementById('legend-toggle');
  const legendPanel = document.getElementById('legend-panel');
  if (legendToggle && legendPanel) {
    legendToggle.addEventListener('click', () => {
      const content = legendPanel.querySelector('.collapse-content');
      const icon = legendPanel.querySelector('.collapse-icon');
      if (content.style.maxHeight === '0px' || !content.style.maxHeight) {
        content.style.maxHeight = content.scrollHeight + 'px';
        content.style.padding = '1rem 1.5rem 1.5rem 1.5rem';
        icon.innerText = '▲ Collapse Guide';
      } else {
        content.style.maxHeight = '0px';
        content.style.padding = '0 1.5rem';
        icon.innerText = '▼ Expand Guide';
      }
    });
  }
  
  // Tab Switching (Narratives vs. Rule Assistant Chat)
  const tabNarrativesBtn = document.getElementById('tab-narratives-btn');
  const tabChatBtn = document.getElementById('tab-chat-btn');
  const narrationBox = document.getElementById('narration-box');
  const chatBox = document.getElementById('chat-box');
  
  if (tabNarrativesBtn && tabChatBtn && narrationBox && chatBox) {
    tabNarrativesBtn.addEventListener('click', () => {
      tabNarrativesBtn.classList.add('active');
      tabNarrativesBtn.style.borderBottom = '2px solid var(--accent-primary)';
      tabNarrativesBtn.style.color = 'var(--text-color)';
      
      tabChatBtn.classList.remove('active');
      tabChatBtn.style.borderBottom = '2px solid transparent';
      tabChatBtn.style.color = 'var(--text-muted)';
      
      narrationBox.style.display = 'block';
      chatBox.style.display = 'none';
    });
    
    tabChatBtn.addEventListener('click', () => {
      tabChatBtn.classList.add('active');
      tabChatBtn.style.borderBottom = '2px solid var(--accent-primary)';
      tabChatBtn.style.color = 'var(--text-color)';
      
      tabNarrativesBtn.classList.remove('active');
      tabNarrativesBtn.style.borderBottom = '2px solid transparent';
      tabNarrativesBtn.style.color = 'var(--text-muted)';
      
      narrationBox.style.display = 'none';
      chatBox.style.display = 'flex';
      
      // Focus on chat input when opening the chat
      document.getElementById('chat-input-text')?.focus();
    });
  }
  
  // Chat Send Button click handler
  document.getElementById('chat-send-btn')?.addEventListener('click', handleSendChatMessage);
}

function showScreen(screen) {
  if (screen === 'setup') {
    document.getElementById('setup-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
    document.getElementById('nav-setup-btn').classList.add('active');
    document.getElementById('nav-dash-btn').classList.remove('active');
  } else {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
    document.getElementById('nav-setup-btn').classList.remove('active');
    document.getElementById('nav-dash-btn').classList.add('active');
  }
}

function renderSetupScreen() {
  const container = document.getElementById('tests-config-container');
  container.innerHTML = '';
  
  Object.values(TEST_DEFINITIONS).forEach(test => {
    const isEnabled = state.enabledTests[test.id];
    const plantVal = state.plantedCount[test.id];
    
    const row = document.createElement('div');
    row.className = 'test-row';
    row.innerHTML = `
      <div class="test-info">
        <label class="test-toggle">
          <input type="checkbox" id="check-${test.id}" ${isEnabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <div class="test-details">
          <div class="test-name">${escHtml(test.name)}</div>
          <div class="test-desc">${escHtml(test.desc)}</div>
        </div>
      </div>
      <div class="test-control-inputs ${isEnabled ? '' : 'hidden'}" id="input-group-${test.id}">
        <span>plant</span>
        <select class="plant-select" id="select-${test.id}">
          ${[0,1,2,3,4,5,6,7,8,9,10].map(v => `<option value="${v}" ${v === plantVal ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span>cases</span>
      </div>
    `;
    
    container.appendChild(row);
    
    // Toggle Event
    row.querySelector(`#check-${test.id}`).addEventListener('change', (e) => {
      const active = e.target.checked;
      state.enabledTests[test.id] = active;
      const controls = row.querySelector(`#input-group-${test.id}`);
      if (active) {
        controls.classList.remove('hidden');
      } else {
        controls.classList.add('hidden');
        state.plantedCount[test.id] = 0;
        row.querySelector(`#select-${test.id}`).value = '0';
      }
    });
    
    // Plant Select Event
    row.querySelector(`#select-${test.id}`).addEventListener('change', (e) => {
      state.plantedCount[test.id] = parseInt(e.target.value, 10);
    });
  });
}

function handleGenerateScenario() {
  // Generate clean base
  state.transactions = generateCleanBase(state.baselineSize);
  
  // Inject cases
  Object.keys(TEST_DEFINITIONS).forEach(testId => {
    if (state.enabledTests[testId]) {
      const count = state.plantedCount[testId];
      for (let i = 0; i < count; i++) {
        CASE_BUILDERS[testId](state.transactions, i + 1);
      }
    }
  });
  
  // Run detectors & reconcile
  runDetectionPipeline();
  
  // Clear drill-down selections
  state.selectedExceptionId = null;
  state.activeFilter = 'all';
  state.searchQuery = '';
  document.getElementById('ledger-search').value = '';
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.remove('active');
    if (b.dataset.filter === 'all') b.classList.add('active');
  });
  
  // Reset Chat History state & UI elements
  state.chatHistory = [];
  const chatHistoryEl = document.getElementById('chat-history');
  if (chatHistoryEl) {
    chatHistoryEl.innerHTML = `
      <div class="chat-message system" style="font-size:0.8rem; color:var(--accent-secondary); padding: 0.5rem; background:rgba(99,102,241,0.05); border-radius:4px; border-left: 2px solid var(--accent-secondary);">
        Hello! I am your CCM Rule Assistant. I am fully aware of the transaction records, active audit rules, and detected exceptions. Ask me anything about the results!
      </div>
    `;
  }
  
  // Reset tab selection UI back to narratives tab
  document.getElementById('tab-narratives-btn')?.click();
  
  // Switch to Dashboard
  showScreen('dashboard');
  
  // Fetch Claude explanations (non-blocking)
  fetchClaudeNarrative();
}

function renderDashboard() {
  // Stats
  const totalLedger = state.transactions.length;
  const flaggedCount = state.transactions.filter(t => t.flags.length > 0).length;
  const cleanCount = totalLedger - flaggedCount;
  
  document.getElementById('stat-total').textContent = totalLedger.toLocaleString();
  document.getElementById('stat-flagged').textContent = flaggedCount.toLocaleString();
  document.getElementById('stat-clean').textContent = cleanCount.toLocaleString();
  
  // Planted vs Detected Match count
  let totalPlanted = 0;
  let totalDetected = 0;
  let matches = 0;
  let activeControls = 0;
  
  Object.keys(state.reconciliation).forEach(id => {
    const item = state.reconciliation[id];
    if (item.active) {
      activeControls++;
      totalPlanted += item.planted;
      totalDetected += item.detected;
      if (item.match) matches++;
    }
  });
  
  const reconRatio = activeControls > 0 ? `${matches}/${activeControls}` : '0/0';
  document.getElementById('stat-recon').textContent = reconRatio;
  
  // Pass banner
  const passBanner = document.getElementById('reconciliation-success');
  const allMatch = Object.values(state.reconciliation).every(r => !r.active || r.match);
  if (allMatch && activeControls > 0) {
    passBanner.classList.remove('hidden');
    passBanner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span><strong>Reconciliation Match:</strong> All ${activeControls} active detection rules reconcile perfectly with planted scenarios.</span>
    `;
  } else {
    passBanner.classList.add('hidden');
  }

  renderReconciliationTable();
  renderExceptionsChart();
  renderClaudeNarration();
  renderLedgerTable();
}

function renderReconciliationTable() {
  const tbody = document.getElementById('recon-table-body');
  tbody.innerHTML = '';
  
  Object.values(TEST_DEFINITIONS).forEach(test => {
    const recon = state.reconciliation[test.id] || { planted: 0, detected: 0, match: true, active: false };
    
    let statusBadge = '';
    if (!recon.active) {
      statusBadge = '<span class="status-badge inactive">Disabled</span>';
    } else if (recon.match) {
      statusBadge = '<span class="status-badge pass">Pass</span>';
    } else {
      statusBadge = '<span class="status-badge fail">Fail</span>';
    }
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escHtml(test.name)}</strong></td>
      <td style="text-align: center;">${recon.active ? recon.planted : '-'}</td>
      <td style="text-align: center;">${recon.active ? recon.detected : '-'}</td>
      <td style="text-align: center;">${statusBadge}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderExceptionsChart() {
  const container = document.getElementById('exceptions-chart-box');
  container.innerHTML = '';
  
  // Calculate heights/counts
  const activeTests = Object.values(TEST_DEFINITIONS).filter(t => state.enabledTests[t.id]);
  if (activeTests.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:4rem;">No active controls.</div>';
    return;
  }
  
  const data = activeTests.map(t => {
    const recon = state.reconciliation[t.id];
    return {
      name: t.name,
      short: t.id.replace('test_', 'T'),
      count: recon ? recon.detected : 0
    };
  });
  
  const maxCount = Math.max(...data.map(d => d.count), 1);
  
  // Draw simple SVG Bar chart
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("viewBox", "0 0 500 240");
  
  const margin = { top: 20, right: 20, bottom: 40, left: 40 };
  const width = 500 - margin.left - margin.right;
  const height = 240 - margin.top - margin.bottom;
  
  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const yVal = margin.top + (height / 4) * i;
    const gridVal = Math.round(maxCount - (maxCount / 4) * i);
    
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", margin.left);
    line.setAttribute("y1", yVal);
    line.setAttribute("x2", 500 - margin.right);
    line.setAttribute("y2", yVal);
    line.setAttribute("stroke", "rgba(255,255,255,0.05)");
    svg.appendChild(line);
    
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", margin.left - 10);
    text.setAttribute("y", yVal + 4);
    text.setAttribute("text-anchor", "end");
    text.textContent = gridVal;
    svg.appendChild(text);
  }
  
  // Bar items
  const barWidth = (width / data.length) * 0.6;
  const spacing = (width / data.length) * 0.4;
  
  data.forEach((d, idx) => {
    const barHeight = (d.count / maxCount) * height;
    const x = margin.left + idx * (barWidth + spacing) + spacing / 2;
    const y = margin.top + height - barHeight;
    
    // Rect
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barWidth);
    rect.setAttribute("height", Math.max(barHeight, 2)); // min height to show baseline
    rect.setAttribute("fill", "var(--accent-primary)");
    
    // Tooltip indicator
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${d.name}: ${d.count} detected`;
    rect.appendChild(title);
    
    svg.appendChild(rect);
    
    // Label x-axis
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", x + barWidth / 2);
    text.setAttribute("y", margin.top + height + 18);
    text.setAttribute("text-anchor", "middle");
    text.textContent = d.short;
    svg.appendChild(text);
  });
  
  container.appendChild(svg);
}

function renderClaudeNarration() {
  const container = document.getElementById('narration-box');
  container.innerHTML = '';
  
  if (state.isNarrating) {
    container.innerHTML = `
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <span>Claude is narrating exceptions...</span>
      </div>
    `;
    return;
  }
  
  if (state.narrationError) {
    const errDiv = document.createElement('div');
    errDiv.style.padding = '1rem';
    errDiv.style.backgroundColor = 'rgba(244,63,94,0.1)';
    errDiv.style.border = '1px solid rgba(244,63,94,0.2)';
    errDiv.style.borderRadius = 'var(--radius-md)';
    errDiv.style.color = 'var(--color-error)';
    errDiv.style.fontSize = '0.85rem';
    errDiv.style.marginBottom = '1rem';
    errDiv.innerHTML = `
      <strong>Narration call failed:</strong> ${escHtml(state.narrationError)}<br>
      <span style="font-size:0.75rem; color:var(--text-muted);">Displaying localized rules-based narration templates instead. Check settings for API keys.</span>
    `;
    container.appendChild(errDiv);
  }
  
  if (!state.narrationData) return;
  
  const layout = document.createElement('div');
  layout.className = 'narration-container';
  
  // Executive Summary
  const summaryBox = document.createElement('div');
  summaryBox.className = 'narration-summary-box';
  summaryBox.textContent = state.narrationData.summary;
  layout.appendChild(summaryBox);
  
  // Findings Cards (one card per test_id)
  const list = document.createElement('div');
  list.className = 'narration-findings-list';
  
  // Group findings by test_id
  const activeTests = {};
  state.exceptions.forEach(ex => {
    if (!activeTests[ex.test_id]) {
      activeTests[ex.test_id] = {
        test_id: ex.test_id,
        test_name: ex.test_name,
        exceptions: [],
        total_rows: 0
      };
    }
    activeTests[ex.test_id].exceptions.push(ex);
    activeTests[ex.test_id].total_rows += ex.rows.length;
  });
  
  Object.values(activeTests).forEach(group => {
    const explanation = state.narrationData.narrations[group.test_id] || 'Compliance exceptions detected. Review required.';
    const isHighlighted = state.selectedExceptionId === group.test_id;
    
    const card = document.createElement('div');
    card.className = `finding-card ${isHighlighted ? 'active-highlight' : ''}`;
    if (isHighlighted) {
      card.style.borderLeft = '4px solid var(--accent-secondary)';
      card.style.backgroundColor = 'rgba(255,255,255,0.05)';
    }
    
    // Build detail counts: e.g. "3 cases, 6 rows"
    const casesCount = group.exceptions.length;
    const casesText = casesCount === 1 ? '1 case' : `${casesCount} cases`;
    const rowsText = group.total_rows === 1 ? '1 row' : `${group.total_rows} rows`;
    
    card.innerHTML = `
      <div class="finding-header">
        <div class="finding-title-container">
          <div class="finding-indicator"></div>
          <div class="finding-test-name">${escHtml(group.test_name)}</div>
        </div>
        <div class="finding-count">${casesText} (${rowsText})</div>
      </div>
      <div class="finding-body">${escHtml(explanation)}</div>
      <div class="finding-footer">
        <div>Scope: <strong>Audit rule exceptions</strong></div>
        <div class="finding-action-link">
          <span>${isHighlighted ? 'Reset Filter' : 'Filter Ledger'}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      </div>
    `;
    
    card.addEventListener('click', () => {
      handleExceptionDrillDown(group.test_id);
    });
    
    list.appendChild(card);
  });
  
  layout.appendChild(list);
  container.appendChild(layout);
}

function handleExceptionDrillDown(exId) {
  if (state.selectedExceptionId === exId) {
    state.selectedExceptionId = null; // Toggle off
  } else {
    state.selectedExceptionId = exId;
  }
  
  renderClaudeNarration();
  renderLedgerTable();
  
  // Scroll transaction table into view if selected
  if (state.selectedExceptionId) {
    const tableRow = document.querySelector('.ledger-table tbody tr.highlighted');
    if (tableRow) {
      tableRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function renderLedgerTable() {
  const tbody = document.getElementById('ledger-table-body');
  tbody.innerHTML = '';
  
  // Toggle reset link visibility
  const clearLink = document.getElementById('clear-selections-link');
  if (state.selectedExceptionId) {
    clearLink?.classList.remove('hidden');
  } else {
    clearLink?.classList.add('hidden');
  }
  
  // Filter and Search logic
  let filtered = [...state.transactions];
  
  if (state.selectedExceptionId) {
    if (state.selectedExceptionId.startsWith('test_')) {
      // It's a test rule ID: show all transactions flagged for this rule
      filtered = filtered.filter(t => t.flags.includes(state.selectedExceptionId));
    } else {
      // Drill-down individual exception row filter overrides other filters to isolate evidence
      const selectedEx = state.exceptions.find(ex => ex.id === state.selectedExceptionId);
      if (selectedEx) {
        filtered = filtered.filter(t => selectedEx.txn_ids.includes(t.txn_id) || selectedEx.rows.some(r => r.txn_id === t.txn_id));
      }
    }
  } else {
    // Normal Filters
    if (state.activeFilter === 'flagged') {
      filtered = filtered.filter(t => t.flags.length > 0);
    } else if (state.activeFilter === 'clean') {
      filtered = filtered.filter(t => t.flags.length === 0);
    } else if (state.activeFilter.startsWith('test_')) {
      filtered = filtered.filter(t => t.flags.includes(state.activeFilter));
    }
    
    // Search Box
    if (state.searchQuery) {
      filtered = filtered.filter(t => 
        t.txn_id.toLowerCase().includes(state.searchQuery) ||
        t.vendor_name.toLowerCase().includes(state.searchQuery) ||
        t.invoice_no.toLowerCase().includes(state.searchQuery) ||
        (t.po_no && t.po_no.toLowerCase().includes(state.searchQuery)) ||
        t.amount.toString().includes(state.searchQuery) ||
        t.approver.toLowerCase().includes(state.searchQuery)
      );
    }
  }
  
  document.getElementById('ledger-meta-count').textContent = `Showing ${filtered.length} of ${state.transactions.length} records`;
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:3rem;">No transactions match criteria.</td></tr>';
    return;
  }
  
  filtered.forEach(t => {
    const isFlagged = t.flags.length > 0;
    const isHighlighted = state.selectedExceptionId && 
      state.exceptions.find(ex => ex.id === state.selectedExceptionId)?.txn_ids.includes(t.txn_id);
    
    const tr = document.createElement('tr');
    if (isHighlighted) {
      tr.className = 'highlighted';
    } else if (isFlagged) {
      tr.className = 'flagged';
    }
    
    // Format timestamp
    const createdDate = new Date(t.created_ts);
    const dateFormatted = createdDate.toISOString().split('T')[0];
    const timeFormatted = createdDate.toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute:'2-digit'});
    
    // Flags HTML
    const flagsHtml = t.flags.map(flagId => {
      const shortCode = flagId.replace('test_', 'T');
      const fullName = TEST_DEFINITIONS[flagId]?.name || flagId;
      return `<span class="test-flag-badge" title="${escHtml(fullName)}">${escHtml(shortCode)}</span>`;
    }).join(' ');
    
    tr.innerHTML = `
      <td class="txn-id-code">${escHtml(t.txn_id)}</td>
      <td>${escHtml(dateFormatted)} <span style="color:var(--text-muted); font-size:0.75rem;">${timeFormatted}</span></td>
      <td><strong>${escHtml(t.vendor_name)}</strong><br><span style="color:var(--text-muted); font-size:0.7rem;">${escHtml(t.vendor_id)}</span></td>
      <td>${escHtml(t.invoice_no)}</td>
      <td>${t.po_no ? escHtml(t.po_no) : '<span style="color:var(--color-error); font-weight:600;">NULL</span>'}</td>
      <td class="amount-col ${isFlagged ? 'flagged-amount' : ''}">$${t.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td>${escHtml(t.approver)}</td>
      <td><span style="font-family:var(--font-mono); font-size:0.75rem;">${escHtml(t.account_number)}</span></td>
      <td><div class="badge-list">${flagsHtml}</div></td>
    `;
    tbody.appendChild(tr);
  });
}

// ────────────────────────────────────────────────────────────────────────
// SECTION 8: In-browser verification hook (Reconciliation tests)
// ────────────────────────────────────────────────────────────────────────

// Programmatic verification script. Expose to global window scope.
window.__testCitations = window.runDetectionsVerify = function() {
  console.log('Running CCM verification suite...');
  
  // 1. Verify Clean Base has exactly 0 exceptions
  const testCleanBase = generateCleanBase(500);
  let cleanFailures = 0;
  
  Object.keys(TEST_DEFINITIONS).forEach(testId => {
    const exceptions = DETECTORS[testId](testCleanBase);
    if (exceptions.length > 0) {
      console.error(`FAIL: Clean base triggered exception detector: ${testId}`, exceptions);
      cleanFailures += exceptions.length;
    }
  });
  
  // 2. Verify Case Planting matches detection exactly
  // Back up current state variables
  const backupTransactions = state.transactions;
  const backupPlantedCount = { ...state.plantedCount };
  const backupEnabledTests = { ...state.enabledTests };
  const backupReconciliation = { ...state.reconciliation };
  
  // Generate a mock baseline
  state.transactions = generateCleanBase(500);
  
  // Configure mock scenario to plant 1-3 cases of all 10 tests
  Object.keys(TEST_DEFINITIONS).forEach(testId => {
    state.enabledTests[testId] = true;
    state.plantedCount[testId] = Math.floor(randRange(1, 4));
  });
  
  // Plant the cases
  Object.keys(TEST_DEFINITIONS).forEach(testId => {
    const count = state.plantedCount[testId];
    for (let i = 0; i < count; i++) {
      CASE_BUILDERS[testId](state.transactions, i + 1);
    }
  });
  
  // Run detection pipeline
  runDetectionPipeline();
  
  // Evaluate reconciliation matches
  let activeMatches = 0;
  let activeTotal = 0;
  Object.keys(state.reconciliation).forEach(id => {
    const item = state.reconciliation[id];
    if (item.active) {
      activeTotal++;
      if (item.match) {
        activeMatches++;
      } else {
        console.error(`FAIL: Reconciliation mismatch for ${id}. Planted: ${item.planted}, Detected: ${item.detected}`);
        console.log(`Exceptions found for ${id}:`, state.exceptions.filter(ex => ex.test_id === id).map(ex => ({
          id: ex.id,
          vendor: ex.vendor_name,
          details: ex.summary_details,
          txn_ids: ex.txn_ids
        })));
      }
    }
  });
  
  const isPerfectReconciliation = (activeMatches === activeTotal) && (activeTotal === 10);
  
  // Restore state
  state.transactions = backupTransactions;
  state.plantedCount = backupPlantedCount;
  state.enabledTests = backupEnabledTests;
  state.reconciliation = backupReconciliation;
  
  const report = {
    clean_base_zero_exceptions: cleanFailures === 0 ? 'PASS' : `FAIL (${cleanFailures} anomalies detected in clean base)`,
    reconciliation_perfect_match: isPerfectReconciliation ? 'PASS' : `FAIL (${activeTotal - activeMatches} mismatches found)`,
    active_controls_count: activeTotal,
    matches_count: activeMatches,
    status: (cleanFailures === 0 && isPerfectReconciliation) ? 'SUCCESS' : 'FAILURE'
  };
  
  console.table(report);
  return report;
};

// Simple HTML escaping helper
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', initApp);
