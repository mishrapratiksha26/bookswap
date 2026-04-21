// ---------------------------------------------------------------------------
// Seed script — populates Books + Pdfs for end-to-end testing.
//
// Run:   node seeds/seed.js
//
// Env:   DB_URL (defaults to mongodb://localhost:27017/books, same default
//        as app.js — so seeding your local DB just works with no env set).
//
// Behaviour:
//   - Creates (or reuses) 3 demo owner users so books aren't all owned by
//     one person. Without this, the "exclude viewer's own listings" filter
//     would hide the whole library when you log in as that owner.
//   - WIPES the Books and Pdfs collections before inserting, so re-running
//     the seed produces a clean deterministic state. Does NOT touch Users,
//     Reviews, BorrowRequests, Wishlists, Messages — reseeding keeps your
//     existing account and its data intact.
//   - Inserts ~25 books weighted toward EDUCATIONAL (so the curriculum
//     matcher has something to work with), plus a few fiction/thriller
//     titles for variety.
//   - Inserts ~15 PDFs across textbook/notes/previous_papers/reference.
//
// Known limitation: the Python AI service ordinarily fills in `embedding`
// and (for PDFs) `chapter_headings` after a real Cloudinary upload. Seeded
// data starts with empty embeddings — semantic AI search still works for
// real books you upload, and the curriculum flow's fuzzy title match will
// still find seeded educational books by name.
// ---------------------------------------------------------------------------

require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/users");
const Book = require("../models/books");
const Pdf  = require("../models/pdf");

const DB_URL = process.env.DB_URL || "mongodb://localhost:27017/books";

// ---------- Demo owners ----------------------------------------------------
// Three users so clustering (same book posted by multiple owners) actually
// shows something interesting, and the recommendation filter has books to
// surface regardless of which account you log in as.
const DEMO_USERS = [
    { username: "anil_mtech",   email: "anil@bookswap.test",   password: "password123" },
    { username: "kavya_phd",    email: "kavya@bookswap.test",  password: "password123" },
    { username: "rohit_mca",    email: "rohit@bookswap.test",  password: "password123" }
];

// ---------- Stock image URLs ----------------------------------------------
// Public Unsplash book-cover-ish photos. Used so cards have actual images
// instead of placeholders. Cloudinary isn't involved — these are direct
// https URLs, which the Cloudinary ImageSchema accepts (it just stores the
// string).
const COVER_IMAGES = [
    "https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=600",
    "https://images.unsplash.com/photo-1512820790803-83ca734da794?w=600",
    "https://images.unsplash.com/photo-1589998059171-988d887df646?w=600",
    "https://images.unsplash.com/photo-1532012197267-da84d127e765?w=600",
    "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=600",
    "https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=600"
];
const pick = (arr, i) => arr[i % arr.length];

// ---------- Books ----------------------------------------------------------
// Educational-heavy mix. Titles chosen to match books IIT (ISM) MTech
// lecture plans typically recommend — so the curriculum matcher's fuzzy
// title search has hits. Some titles duplicated across owners on purpose
// so the clustering view shows "N copies".
const BOOKS = [
    // ---- Mathematics & Operations Research (dept match for MTech MCO)
    { title: "Operations Research",              author: "Kanti Swarup",        genre: "EDUCATIONAL", price: 520, department: "Mathematics and Computing", course: "MCO502",  publication_year: 2017, description: "Standard IIT textbook covering linear programming, network analysis, CPM/PERT, dynamic programming, and queuing theory. Heavily cited in optimization syllabi." },
    { title: "Operations Research: An Introduction", author: "Hamdy A. Taha",   genre: "EDUCATIONAL", price: 625, department: "Mathematics and Computing", course: "MCO502",  publication_year: 2017, description: "Taha's classic. Rigorous treatment of LP, integer programming, nonlinear optimization, and decision theory with worked examples." },
    { title: "Linear Programming",               author: "G. Hadley",           genre: "EDUCATIONAL", price: 450, department: "Mathematics and Computing", course: "MCO502",  publication_year: 1962, description: "Foundational reference for simplex method, duality theory, and sensitivity analysis." },
    { title: "Numerical Analysis",               author: "Richard L. Burden",   genre: "EDUCATIONAL", price: 580, department: "Mathematics and Computing", course: "MCO401",  publication_year: 2015, description: "Burden & Faires — interpolation, numerical integration, ODE solvers, matrix iterative methods." },
    { title: "Introduction to Probability",      author: "Joseph K. Blitzstein", genre: "EDUCATIONAL", price: 540, department: "Mathematics and Computing", course: "MCO301",  publication_year: 2019, description: "Probability theory with Bayesian emphasis. Harvard course textbook." },
    { title: "Advanced Engineering Mathematics", author: "Erwin Kreyszig",      genre: "EDUCATIONAL", price: 720, department: "Mathematics and Computing", course: "MA201",   publication_year: 2018, description: "Kreyszig — the standard engineering math reference. Complex analysis, PDEs, vector calculus." },

    // ---- Computer Science (dept match for CSE and dual-coded courses)
    { title: "Operating System Concepts",        author: "Abraham Silberschatz", genre: "EDUCATIONAL", price: 650, department: "Computer Science and Engineering", course: "CS301", publication_year: 2018, description: "Galvin/Silberschatz — processes, CPU scheduling, memory management, file systems, security. The 'dinosaur book'." },
    { title: "Database System Concepts",         author: "Abraham Silberschatz", genre: "EDUCATIONAL", price: 640, department: "Computer Science and Engineering", course: "CS302", publication_year: 2019, description: "Relational model, SQL, normalization, transactions, query processing, distributed databases." },
    { title: "Introduction to Algorithms",       author: "Thomas H. Cormen",    genre: "EDUCATIONAL", price: 890, department: "Computer Science and Engineering", course: "CS202", publication_year: 2022, description: "CLRS — definitive algorithms textbook. Sorting, graph algorithms, DP, greedy, NP-completeness." },
    { title: "Computer Networks",                author: "Andrew S. Tanenbaum", genre: "EDUCATIONAL", price: 580, department: "Computer Science and Engineering", course: "CS303", publication_year: 2019, description: "Tanenbaum — TCP/IP, routing, wireless, security. Layer-by-layer walkthrough." },
    { title: "Compilers: Principles, Techniques, and Tools", author: "Alfred V. Aho", genre: "EDUCATIONAL", price: 710, department: "Computer Science and Engineering", course: "CS401", publication_year: 2006, description: "The Dragon Book — lexical/syntax analysis, semantic analysis, code generation, optimization." },
    { title: "Artificial Intelligence: A Modern Approach", author: "Stuart Russell", genre: "EDUCATIONAL", price: 850, department: "Computer Science and Engineering", course: "CS501", publication_year: 2020, description: "Russell & Norvig — search, logic, probabilistic reasoning, learning, NLP, robotics. Standard graduate AI text." },
    { title: "Pattern Recognition and Machine Learning", author: "Christopher M. Bishop", genre: "EDUCATIONAL", price: 780, department: "Computer Science and Engineering", course: "CS502", publication_year: 2006, description: "Bishop PRML — Bayesian ML, kernel methods, graphical models, neural networks, approximate inference." },
    { title: "Deep Learning",                    author: "Ian Goodfellow",      genre: "EDUCATIONAL", price: 690, department: "Computer Science and Engineering", course: "CS503", publication_year: 2016, description: "Goodfellow/Bengio/Courville — backprop, CNNs, RNNs, regularization, generative models." },

    // ---- Electronics & Communication (ECE dept)
    { title: "Signals and Systems",              author: "Alan V. Oppenheim",   genre: "EDUCATIONAL", price: 560, department: "Electronics and Communication Engineering", course: "EC301", publication_year: 2015, description: "Oppenheim & Willsky — continuous/discrete signals, Fourier analysis, Laplace/z-transforms, filtering." },
    { title: "Digital Signal Processing",        author: "John G. Proakis",     genre: "EDUCATIONAL", price: 590, department: "Electronics and Communication Engineering", course: "EC401", publication_year: 2014, description: "Proakis & Manolakis — DFT/FFT, IIR/FIR filter design, multirate DSP, adaptive filters." },
    { title: "Microelectronic Circuits",         author: "Adel S. Sedra",       genre: "EDUCATIONAL", price: 720, department: "Electronics and Communication Engineering", course: "EC201", publication_year: 2019, description: "Sedra/Smith — semiconductor devices, BJT/MOSFET amplifiers, op-amps, digital logic." },

    // ---- Mechanical Engineering
    { title: "Mechanics of Materials",           author: "R. C. Hibbeler",      genre: "EDUCATIONAL", price: 610, department: "Mechanical Engineering", course: "ME201", publication_year: 2017, description: "Stress/strain, torsion, bending, axial loading, beam deflection. Hibbeler's step-by-step style." },
    { title: "Thermodynamics: An Engineering Approach", author: "Yunus A. Çengel", genre: "EDUCATIONAL", price: 640, department: "Mechanical Engineering", course: "ME301", publication_year: 2018, description: "Çengel & Boles — laws of thermodynamics, cycles, mixtures, psychrometrics, combustion." },

    // ---- Fiction / thriller for variety testing
    { title: "The Silent Patient",               author: "Alex Michaelides",    genre: "THRILLER",    price: 350, description: "A psychotherapist becomes obsessed with a woman who shot her husband and hasn't spoken since. Twisty psychological thriller." },
    { title: "Verity",                           author: "Colleen Hoover",      genre: "THRILLER",    price: 320, description: "Struggling writer is hired to finish a bestselling author's series and uncovers a disturbing manuscript." },
    { title: "Gone Girl",                        author: "Gillian Flynn",       genre: "THRILLER",    price: 340, description: "Nick's wife disappears on their fifth anniversary. What looks like a crime novel pivots into something much darker." },
    { title: "Project Hail Mary",                author: "Andy Weir",           genre: "SCIFI",       price: 380, description: "A lone astronaut wakes on a spacecraft with no memory and must save humanity. Hard sci-fi with humour." },
    { title: "The Midnight Library",             author: "Matt Haig",           genre: "FICTION",     price: 310, description: "Between life and death is a library where every book is a life you could have lived." },
    { title: "Atomic Habits",                    author: "James Clear",         genre: "NON-FICTION", price: 290, description: "Small habits compound into remarkable results. Practical framework for behaviour change." },

    // ---- Duplicate listings (same title+author, different owners) —
    // exercises the clustering aggregation ("3 copies available").
    { title: "Operating System Concepts",        author: "Abraham Silberschatz", genre: "EDUCATIONAL", price: 650, department: "Computer Science and Engineering", course: "CS301", publication_year: 2018, description: "Galvin/Silberschatz — second copy from a different owner. Tests cluster display." },
    { title: "Introduction to Algorithms",       author: "Thomas H. Cormen",    genre: "EDUCATIONAL", price: 890, department: "Computer Science and Engineering", course: "CS202", publication_year: 2022, description: "CLRS — second copy from a different owner." },
    { title: "The Silent Patient",               author: "Alex Michaelides",    genre: "THRILLER",    price: 350, description: "Duplicate copy for cluster testing." }
];

// ---------- PDFs -----------------------------------------------------------
// Mix of textbook / notes / previous_papers / reference across departments.
// cloudinary_url is a real public PDF so Download works end-to-end in demos.
const DUMMY_PDF_URL       = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const DUMMY_PDF_PUBLIC_ID = "demo/dummy";

const PDFS = [
    // ---- Textbook soft copies (same titles as books — duplicates by design)
    { title: "Operations Research — Kanti Swarup (soft copy)", subject: "Operations Research", course: "MCO502", department: "Mathematics and Computing", professor: "Prof. S. Mondal", resource_type: "textbook", description: "Full PDF of Kanti Swarup's OR textbook. Chapters on LP, network analysis, DP, queuing." },
    { title: "Operating System Concepts — Galvin",             subject: "Operating Systems",   course: "CS301",  department: "Computer Science and Engineering", professor: "Prof. R. Kumar",  resource_type: "textbook", description: "Classic Galvin/Silberschatz OS text." },
    { title: "Introduction to Algorithms — CLRS",              subject: "Algorithms",          course: "CS202",  department: "Computer Science and Engineering", professor: "Prof. A. Singh",  resource_type: "textbook", description: "CLRS full text." },
    { title: "Deep Learning — Goodfellow",                     subject: "Machine Learning",    course: "CS503",  department: "Computer Science and Engineering", professor: "Prof. P. Sharma", resource_type: "textbook", description: "Goodfellow/Bengio/Courville Deep Learning." },

    // ---- Class notes
    { title: "OS Notes — Process Scheduling & Memory Management", subject: "Operating Systems", course: "CS301", department: "Computer Science and Engineering", professor: "Prof. R. Kumar", resource_type: "notes", description: "Second-year student notes covering CPU scheduling algorithms (FCFS, SJF, RR, MLFQ), paging, segmentation, virtual memory." },
    { title: "DBMS Notes — Normalization & Transactions",         subject: "DBMS",              course: "CS302", department: "Computer Science and Engineering", professor: "Prof. M. Verma", resource_type: "notes", description: "1NF-BCNF, transaction isolation levels, ACID, locking protocols." },
    { title: "Algorithms Notes — DP & Greedy",                    subject: "Algorithms",        course: "CS202", department: "Computer Science and Engineering", professor: "Prof. A. Singh", resource_type: "notes", description: "DP formulations (0/1 knapsack, LCS, matrix chain), greedy proofs (Huffman, MST)." },
    { title: "OR Notes — Simplex & Duality",                      subject: "Operations Research", course: "MCO502", department: "Mathematics and Computing", professor: "Prof. S. Mondal", resource_type: "notes", description: "Simplex tableau, big-M method, two-phase method, primal-dual relationships." },
    { title: "Numerical Methods Notes",                           subject: "Numerical Analysis", course: "MCO401", department: "Mathematics and Computing", professor: "Prof. D. Roy", resource_type: "notes", description: "Newton-Raphson, Gauss elimination, Runge-Kutta ODE solvers, finite differences." },
    { title: "DSP Notes — Filter Design",                         subject: "Digital Signal Processing", course: "EC401", department: "Electronics and Communication Engineering", professor: "Prof. V. Iyer", resource_type: "notes", description: "IIR (Butterworth, Chebyshev) and FIR (windowing, Parks-McClellan) filter design." },

    // ---- Previous year question papers
    { title: "OS End-Sem — 2023",                                 subject: "Operating Systems", course: "CS301", department: "Computer Science and Engineering", professor: "", resource_type: "previous_papers", description: "End-semester exam paper for Operating Systems, 2023 session." },
    { title: "DBMS Mid-Sem — 2024",                               subject: "DBMS",              course: "CS302", department: "Computer Science and Engineering", professor: "", resource_type: "previous_papers", description: "Mid-sem paper covering relational model, SQL, normalization." },
    { title: "Operations Research End-Sem — 2024",                subject: "Operations Research", course: "MCO502", department: "Mathematics and Computing", professor: "", resource_type: "previous_papers", description: "End-sem paper for OR, MCO502." },
    { title: "Algorithms End-Sem — 2023",                         subject: "Algorithms",        course: "CS202", department: "Computer Science and Engineering", professor: "", resource_type: "previous_papers", description: "End-sem paper for CS202 Algorithms." },

    // ---- Reference material
    { title: "AI Modern Approach — Chapter Reference",            subject: "Artificial Intelligence", course: "CS501", department: "Computer Science and Engineering", professor: "Prof. P. Sharma", resource_type: "reference", description: "Reference reading for AI. Search, logic, probabilistic reasoning." },
    { title: "Kreyszig — Engineering Mathematics Reference",      subject: "Engineering Mathematics", course: "MA201", department: "Mathematics and Computing", professor: "Prof. D. Roy", resource_type: "reference", description: "Kreyszig reference PDF." }
];

// ---------- Main ----------------------------------------------------------

async function findOrCreateUser(u) {
    const existing = await User.findOne({ username: u.username });
    if (existing) {
        console.log(`  · reused user: ${u.username}`);
        return existing;
    }
    const user = new User({ email: u.email, username: u.username });
    const created = await User.register(user, u.password);
    console.log(`  · created user: ${u.username} (password: ${u.password})`);
    return created;
}

async function seed() {
    await mongoose.connect(DB_URL);
    console.log(`connected to ${DB_URL}`);

    console.log("\n[1/4] Owners");
    const owners = [];
    for (const u of DEMO_USERS) owners.push(await findOrCreateUser(u));

    console.log("\n[2/4] Wiping Books & Pdfs (users, reviews, borrows untouched)");
    const b = await Book.deleteMany({});
    const p = await Pdf.deleteMany({});
    console.log(`  · removed ${b.deletedCount} books, ${p.deletedCount} pdfs`);

    console.log("\n[3/4] Inserting books");
    const bookDocs = BOOKS.map((b, i) => ({
        ...b,
        owner: owners[i % owners.length]._id,              // round-robin owner
        available: i % 7 !== 0,                            // ~1 in 7 is borrowed
        images: [{
            url: pick(COVER_IMAGES, i),
            filename: `seed-cover-${i}`
        }],
        avg_rating: Number(((i % 5) + 1 + 0.5 * ((i * 7) % 2)).toFixed(1))  // 1.0–5.5, deterministic
    }));
    await Book.insertMany(bookDocs);
    console.log(`  · inserted ${bookDocs.length} books`);

    console.log("\n[4/4] Inserting PDFs");
    const pdfDocs = PDFS.map((p, i) => ({
        ...p,
        cloudinary_url: DUMMY_PDF_URL,
        cloudinary_public_id: `${DUMMY_PDF_PUBLIC_ID}-${i}`,
        uploadedBy: owners[i % owners.length]._id,
        download_count: (i * 3) % 17,
        chapter_headings: []        // Python service fills these after real upload
    }));
    await Pdf.insertMany(pdfDocs);
    console.log(`  · inserted ${pdfDocs.length} pdfs`);

    const educationalCount = BOOKS.filter(b => b.genre === "EDUCATIONAL").length;
    console.log(`\nDone.`);
    console.log(`  owners:      ${owners.length}`);
    console.log(`  books:       ${BOOKS.length}  (educational: ${educationalCount}, other: ${BOOKS.length - educationalCount})`);
    console.log(`  pdfs:        ${PDFS.length}`);
    console.log(`\nTo log in as a seeded owner: username = anil_mtech / kavya_phd / rohit_mca, password = password123`);

    await mongoose.disconnect();
}

seed().catch(err => {
    console.error("\nSEED FAILED:", err);
    process.exit(1);
});
