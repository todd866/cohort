/**
 * Authored names for manifold regions.
 *
 * The auto-labeller names a cluster from the commonest topic tag of its members, which is exactly the tag that does NOT distinguish it from its siblings. Seven CAH clusters were therefore all called 'Surgery' and seven more 'Neurology'. These names come from what is actually IN each region, read off audit:cluster-naming-queue, which returns terms common inside a cluster and rare across the rotation.
 *
 * HOW TO EXTEND: Run `npm run audit:cluster-naming-queue -- --rotation <r>`, read a block, and name the region from its contents. Keep `evidence` populated: a bare identifier outlives whoever wrote it and then gets argued about, which is precisely how a pinned image removal came to read as a prohibition on illustrating a card at all.
 *
 * SCOPE: Display only. Nothing keys off these strings; the cluster ids remain the identity.
 *
 * Lives in src/ rather than content/ because the module that reads it ships in
 * the open distribution and content/ is a forbidden root there — a shipped file
 * importing from an unshippable one breaks the exported build, which is the
 * failure that cost two release attempts on 2026-09-16.
 *
 * Authored 2026-09-17.
 *
 * The eleven broad CAH regions split on 2026-09-22 (cah-cluster-0, 15, 16, 42,
 * 46, 56, 63, 76, 96, 98, 104) no longer exist. Their entries below are history.
 * Live children are `cah-cluster-s1-*`. Most keep the name written at the split.
 * The six entries at the bottom replace a split name that was still a specialty
 * tag or a section heading.
 */

export interface ClusterNameEntry {
  /** Null where the region resists naming — see `needsSplit`. */
  name: string | null;
  /**
   * The region is not one subject and wants splitting or dissolving rather than
   * a label. Naming it would hide the finding.
   */
  needsSplit?: boolean;
  /** Why it carries this name, or this refusal. */
  evidence: string;
}

export const CLUSTER_NAMES: Readonly<Record<string, ClusterNameEntry>> = {
  "cah-cluster-63": {
    name: "Groin and scrotum",
    evidence: "circumcision, cremasteric, orchidopexy, hydrocele, processus; undescended testis, torsion, inguinal hernia",
  },
  "cah-cluster-82": {
    name: "Neonatal congenital surgery",
    evidence: "aganglionic, Meckel, diaphragmatic, posterolaterally; Hirschsprung, oesophageal atresia, abdominal-wall defects",
  },
  "cah-cluster-17": {
    name: "Infant vomiting and obstruction",
    evidence: "forceful, non-bilious, volvulus, processus; pyloric stenosis, malrotation",
  },
  "cah-cluster-107": {
    name: "Neck lumps",
    evidence: "branchial, dermoid, hygroma, ranula, sternomastoid; thyroglossal duct cyst",
  },
  "cah-cluster-81": {
    name: "Appendicitis",
    evidence: "appendix, mesoappendix, peritonism, iliac, anorexia",
  },
  "cah-cluster-66": {
    name: "Intussusception",
    evidence: "redcurrant-jelly, sausage-shaped, enema, colicky, non-operative",
  },
  "cah-cluster-54": {
    name: "Seizures and funny turns",
    evidence: "centrotemporal, convulsive, bimodal; febrile seizure, neonatal jitteriness, syncope",
  },
  "cah-cluster-12": {
    name: "Headache, head injury and raised pressure",
    evidence: "neuroimaging, macrocephaly, migraine, headache, suture; GCS, brain tumour",
  },
  "cah-cluster-31": {
    name: "Neuromuscular weakness",
    evidence: "Duchenne, Guillain-Barré, Charcot-Marie-Tooth, waddling, dystrophy; upper versus lower motor neuron",
  },
  "cah-cluster-32": {
    name: "Cerebral palsy and neurodisability",
    evidence: "spastic, non-progressive, developing-brain, palsy; neural tube defects",
  },
  "cah-cluster-92": {
    name: "Infantile spasms",
    evidence: "hypsarrhythmia, vigabatrin, West, high-amplitude, spasms",
  },
  "cah-cluster-80": {
    name: "Tic disorders",
    evidence: "tics, vocalisations, non-rhythmic, suppressible",
  },
  "cah-cluster-24": {
    name: "Puberty and its disorders",
    evidence: "androgens, gynaecomastia, pubic-hair, LH-driven, Tanner; precocious puberty, thelarche",
  },
  "cah-cluster-109": {
    name: "Hypoglycaemia and overgrowth syndromes",
    evidence: "Prader-Willi, Beckwith-Wiedemann, insatiable, large-for-dates, finger-prick; the critical sample",
  },
  "cah-cluster-97": {
    name: "Adrenal disorders and new diabetes",
    evidence: "hydrocortisone, salt-wasting, 21-hydroxylase, aldosterone, crisis; congenital adrenal hyperplasia, type 1 onset",
  },
  "cah-cluster-57": {
    name: "Diabetic ketoacidosis and metabolic emergencies",
    evidence: "ketoacidosis, Kussmaul, lysis, refeeding; tumour lysis, potassium shift",
  },
  "cah-cluster-44": {
    name: "Congenital heart disease",
    evidence: "22q11, alprostadil, boot-shaped, coarctation, ductal, Ebstein, Eisenmenger; tetralogy",
  },
  "cah-cluster-37": {
    name: "Murmurs",
    evidence: "innocent, machinery, Levine, diastole, bounding; patent ductus, atrial septal defect",
  },
  "cah-cluster-65": {
    name: "Cardiac embryology and septal defects",
    evidence: "septation, foramen ovale, pansystolic, atrial septum; ventricular septal defect, Marfan aortic root",
  },
  "cah-cluster-2": {
    name: "Umbilical and central lines",
    evidence: "brachiocephalic, caudally, jugular, right-atrial, umbilical catheter tip position",
  },
  "cah-cluster-64": {
    name: "The normal paediatric ECG",
    evidence: "right ventricular dominance, axis deviation, fetal circulation, lead V1",
  },
  "cah-cluster-34": {
    name: "Choking and inhaled foreign body",
    evidence: "ball-valve, blows, bronchoscopy, chokes, atelectasis; back blows, unilateral wheeze",
  },
  "cah-cluster-99": {
    name: "Otitis media and sore throat",
    evidence: "Centor, eardrum, eustachian, otoscopic; tonsillitis, quinsy, glue ear",
  },
  "cah-cluster-47": {
    name: "Chronic ear discharge and cholesteatoma",
    evidence: "attic, CSOM, pars flaccida, eroding, cholesteatoma, mastoidectomy",
  },
  "cah-cluster-62": {
    name: "Nasal obstruction and epistaxis",
    evidence: "adenoid, epistaxis, nostril, septal haematoma, polyps, allergic crease",
  },
  "cah-cluster-102": {
    name: "Sinusitis",
    evidence: "sinusitis, facial pain, chronic beyond, odynophagia",
  },
  "cah-cluster-26": {
    name: "Strabismus and eye movement",
    evidence: "esotropia, exotropia, Duane, diplopia, gaze, corneal light reflex; amblyopia",
  },
  "cah-cluster-38": {
    name: "Conjunctivitis",
    evidence: "conjunctiva, vernal, pre-auricular, cornea; bacterial, allergic, Kawasaki sparing",
  },
  "cah-cluster-87": {
    name: "Neonatal eye discharge",
    evidence: "gonococcal, chlamydia, mucopurulent, sight-threatening, onset day; nasolacrimal obstruction",
  },
  "cah-cluster-11": {
    name: "Retinoblastoma and childhood tumours",
    evidence: "retinoblastoma, enucleation; nephroblastoma, acute lymphoblastic leukaemia",
  },
  "cah-cluster-74": {
    name: "Chronic diarrhoea and malabsorption",
    evidence: "lactose, reducing-substances, sucrase, lactase, secretory versus osmotic",
  },
  "cah-cluster-4": {
    name: "Reflux and safe sleep",
    evidence: "effortless, GORD, regurgitation, SIDS, sphincter, supine",
  },
  "cah-cluster-83": {
    name: "Constipation and enuresis",
    evidence: "macrogol, polyethylene glycol, laxatives, enuresis, bladder capacity",
  },
  "cah-cluster-0": {
    name: "Rashes and skin lesions",
    evidence: "acral, blistering, café-au-lait, Nikolsky, molluscum, scabies; 232 cards — large enough to split later",
  },
  "cah-cluster-105": {
    name: "Eczema",
    evidence: "flexures, emollients, skin-barrier, filaggrin, loss-of-function; molluscum dermatitis",
  },
  "cah-cluster-67": {
    name: "Vascular birthmarks",
    evidence: "haemangioma, involution, proliferative, plateau; propranolol, port-wine stain",
  },
  "cah-cluster-25": {
    name: "Juvenile idiopathic arthritis",
    evidence: "oligoarticular, polyarticular, enthesitis-related, uveitis, psoriatic; septic arthritis, Still disease",
  },
  "cah-cluster-101": {
    name: "Lupus and connective tissue disease",
    evidence: "erythematosus, dermatomyositis, hyperextensible, hypermobile; Gottron papules, Ehlers-Danlos",
  },
  "cah-cluster-72": {
    name: "Growing pains and overuse",
    evidence: "apophysitis, tibial, patellar pole, sporty, traction; Osgood-Schlatter",
  },
  "cah-cluster-86": {
    name: "Resuscitation drugs and anaphylaxis",
    evidence: "auto-injector, EpiPen, intraosseous drills, midazolam, microg; adrenaline dosing",
  },
  "cah-cluster-29": {
    name: "Primary immunodeficiency",
    evidence: "agammaglobulinaemia, SCID, phagocyte, oxidative, opportunistic; delayed cord separation",
  },
  "cah-cluster-68": {
    name: "Food allergy and immunotherapy",
    evidence: "LEAP, FPIES, outgrown, oral immunotherapy, peanut introduction",
  },
  "cah-cluster-89": {
    name: "Red reflex and leukocoria",
    evidence: "leukocoria, pupillary, red reflex, lens; retinopathy of prematurity",
  },
  "cah-cluster-70": {
    name: "Mastoiditis and otoscopy technique",
    evidence: "mastoid, post-auricular, postero-superior, grommet, pinna direction",
  },
  "cah-cluster-93": {
    name: "Otitis externa and hearing tests",
    evidence: "tragus, externa, audiogram, air-bone gap, pulling the pinna",
  },
  "cah-cluster-16": {
    name: "Neonatal jaundice and liver disease",
    evidence: "biliary atresia, Alagille, Budd-Chiari, caeruloplasmin, cholestasis, phototherapy",
  },
  "cah-cluster-96": {
    name: "Asthma assessment and action plans",
    evidence: "6-11, hyperresponsiveness, limitation, low-dose, burden; asthma first aid, viral-induced wheeze",
  },
  "cah-cluster-30": {
    name: "Asthma and bronchodilator drugs",
    evidence: "beta-2 agonist, antagonist, long-acting, bronchospasm; montelukast, inhaled corticosteroid",
  },
  "cah-cluster-76": {
    name: "Croup, bronchiolitis and stridor",
    evidence: "croup, epiglottitis, cricoid, biphasic, glottic; respiratory syncytial virus",
  },
  "cah-cluster-46": {
    name: "Meningitis and neonatal sepsis",
    evidence: "benzylpenicillin, pyogenic, early-onset, adjunctive, cocci; cerebrospinal fluid differential",
  },
  "cah-cluster-8": {
    name: "Congenital infection",
    evidence: "cytomegalovirus, toxoplasmosis, calcification, cataracts, chorioretinitis; TORCH",
  },
  "cah-cluster-91": {
    name: "Urinary tract infection and reflux",
    evidence: "vesicoureteral, MCUG, suprapubic, cystitis, renal-tract",
  },
  "cah-cluster-22": {
    name: "Nephrotic syndrome and blood pressure",
    evidence: "minimal change, steroid-responsive, relapse, cuff width, oncotic",
  },
  "cah-cluster-51": {
    name: "ADHD and autism",
    evidence: "inattention, hyperactivity, impulsivity, executive-control; stimulants",
  },
  "cah-cluster-79": {
    name: "Prevalence and sex ratios",
    evidence: "preponderance, heritable, incidence, M:F ratios; DDH, autism, ADHD epidemiology",
  },
  "cah-cluster-27": {
    name: "Consent and Gillick competence",
    evidence: "Gillick, competent, parental responsibility, court, emergency treatment",
  },
  "cah-cluster-35": {
    name: "Adolescent risk and self-harm",
    evidence: "drivers, adult-like, non-suicidal self-injury, chronic illness, contraception",
  },
  "cah-cluster-59": {
    name: "Toxic megacolon",
    evidence: "megacolon, toxic, gut rest, IV steroids, motility drugs avoided",
  },
  "cah-cluster-98": {
    name: "Fluids, dehydration and shock",
    evidence: "Holliday-Segar, boluses, massive transfusion, citrate, hypotension threshold",
  },
  "cah-cluster-56": {
    name: "Paediatric radiology",
    evidence: "silhouette sign, thymus, aerated, adenomatoid, bubble; collapse and consolidation",
  },
  "cah-cluster-42": {
    name: "Growth and developmental milestones",
    evidence: "centiles, plotted, mid-parental height, babbling, M-CHAT, copy a circle",
  },
  "cah-cluster-88": {
    name: "Childhood cancers",
    evidence: "blast, hyperdiploidy, hepatoblastoma, Wilms, neuroblastoma, febrile neutropaenia",
  },
  "cah-cluster-85": {
    name: null,
    needsSplit: true,
    evidence: "120 cards, 71% from one source file and only 3% sharing a subject — the most file-shaped region in CAH per audit:cluster-shape. Contents run from a laparoscopic Endoloop to occipital hair loss to Cushingoid striae to urticaria, with no common subject. Naming it would put a label on a document rather than a topic; it wants splitting or dissolving.",
  },
  "cah-cluster-104": {
    name: "Fractures and bone health",
    evidence: "osteomyelitis, Salter-Harris, bowed, costochondral, bone age; rickets, pulmonary contusion",
  },
  "cah-cluster-15": {
    name: "Dysmorphic syndromes",
    evidence: "Cornelia, downward-slanting, bulbous, clenched, turribrachycephaly; Williams, CHARGE, 22q11",
  },
  "cah-cluster-75": {
    name: "The limping child and hip disorders",
    evidence: "SCFE, avascular, capital, femoral-head, fragmentation; Perthes, DDH, transient synovitis",
  },
  "cah-cluster-13": {
    name: "Burns",
    evidence: "Parkland, Lund-Browder, TBSA, cooling, Jackson; burn fluid resuscitation",
  },
  "cah-cluster-7": {
    name: "Anaemia and haemoglobin disorders",
    evidence: "chelation, globin-chain, macrocytic, nadir, haemodilution; thalassaemia, parvovirus B19",
  },
  "cah-cluster-61": {
    name: "Resuscitation and the sick newborn",
    evidence: "bagging, compressions, 100-120, mask seal, meconium; heart failure in infancy, trauma triad",
  },
  "cah-cluster-94": {
    name: "Kawasaki disease and rheumatic fever",
    evidence: "CRASH, coronary aneurysm, scarlet, coxsackie; secondary prophylaxis",
  },
  "cah-cluster-28": {
    name: "Cystic fibrosis",
    evidence: "dornase alfa, ivacaftor, lumacaftor, correctors, modulators, sweat test",
  },
  "cah-cluster-48": {
    name: "Teeth and dental injury",
    evidence: "avulsed, caries, deciduous, dentition, enamel, erupt",
  },
  "cah-cluster-9": {
    name: "Childhood exanthems",
    evidence: "roseola infantum, measles, Koplik, VCA-IgM, prodrome; hand foot and mouth, EBV rash",
  },
  "cah-cluster-78": {
    name: "Vaccines and contraindications",
    evidence: "live attenuated, LAIV, polysaccharide, immunosuppression, anti-HBs",
  },
  "cah-cluster-18": {
    name: "The immunisation schedule",
    evidence: "hexavalent, DTPa-HepB-IPV-Hib, primary course, measles-containing, catch-up intervals",
  },
  "cah-cluster-77": {
    name: "Genetic testing and malformations",
    evidence: "VACTERL, microarray, malformation versus deformation, organogenesis",
  },
  "cah-cluster-73": {
    name: "Pneumonia and empyema",
    evidence: "mycoplasma, community-acquired, well-circumscribed, cephalosporin; round pneumonia",
  },
  "cah-cluster-10": {
    name: "Bleeding disorders",
    evidence: "haemophilia, Christmas, haemarthroses, mucocutaneous, aPTT; von Willebrand, ITP",
  },
  "cah-cluster-69": {
    name: "Allergy testing",
    evidence: "skin prick, wheal, IgE-mediated, reproducible, predictive; oral food challenge",
  },
  "cah-cluster-55": {
    name: "Obstructive sleep apnoea and tonsils",
    evidence: "adenotonsillar, adenotonsillectomy, polysomnography, snoring, kissing tonsils",
  },
  "cah-cluster-84": {
    name: "Child protection and mandatory reporting",
    evidence: "maltreatment, mandatory reporting, risk of significant harm, jurisdictions, carer",
  },
  "cah-cluster-6": {
    name: "Sleep stages and parasomnias",
    evidence: "night terrors, slow-wave, arousal, alpha wave, REM; labelled 'Respiratory', which it is not",
  },
  "cah-cluster-5": {
    name: "Adolescent sleep and contraception",
    evidence: "LARC, implants, IUDs, cannabis, slow-wave decline; narcolepsy and cataplexy",
  },
  "cah-cluster-36": {
    name: "Glomerulonephritis",
    evidence: "PSGN, cola-coloured, smoky, nephritic, synpharyngitic; nephrotic triad",
  },
  "cah-cluster-60": {
    name: "Pertussis",
    evidence: "Bordetella, coccobacillus, post-tussive, whoop, catarrhal, azithromycin",
  },
  "cah-cluster-90": {
    name: "Gastroenteritis and infection control",
    evidence: "norovirus, alcohol-based, soap, hand hygiene; mixed with inflammatory markers and paracetamol toxicity",
  },
  "cah-cluster-53": {
    name: null,
    needsSplit: true,
    evidence: "Read in full, 31 cards: 21 from the visual-recognition file. Seventeen are skin diagnoses made by looking — urticaria, Mongolian spot, cradle cap, tinea capitis, cold sores, vitiligo, pityriasis rosea, lichen planus, cellulitis, zoster, milia, erythema nodosum, measles, port-wine stain — and the rest are three radiographs, intussusception three times, croup, scarlet fever and EBV. The shared property is the question FORMAT, spot diagnosis, not a subject. Remedy: dissolve and let backfill re-home each card by embedding; do not name.",
  },
  "cah-cluster-49": {
    name: "Purpura, bruising and bleeding",
    evidence: "Refused a name on a six-front sample that read as abusive head trauma beside thrombotic microangiopathy. All forty fronts say otherwise: ITP, HSP/IgA vasculitis, HUS, meningococcal purpura and non-accidental bruising are one clinical question — a child with petechiae, purpura or bruises, what is it — and the geometry had it right. Strays: two migraine cards, the lethal triad, CMV retinitis.",
  },
  "cah-cluster-s1-16-R-R": {
    name: "Chronic liver disease",
    evidence: "64 live cards, 2026-09-22. Stored name was Gastroenterology, the week-list tag. Fronts are liver failure, transplant decompensation, hepatitis B, Alagille, alkaline phosphatase of growth, alpha-1 antitrypsin. Files: chronic-liver-disease-management, scaffold-lft-interpretation, cholestasis-workup-alagille.",
  },
  "cah-cluster-s1-63-R": {
    name: "Acute scrotum and foreskin",
    evidence: "60 live cards, 2026-09-22. Stored name was Surgery. Fronts are torsion, bell-clapper, paraphimosis, phimosis, hydrocele, varicocele, idiopathic scrotal oedema. The sibling leaf is already Groin and scrotum. Files: y3g-week4-surgery-b1/b2/b3.",
  },
  "cah-cluster-s1-56-R-R": {
    name: "Neonatal radiographs",
    evidence: "50 live cards, 2026-09-22. Stored name was The neonatal cases, a section heading. Fronts are NEC pneumatosis, TTN, RDS, pneumothorax, meconium ileus pattern, double bubble, Pierre Robin profile. Files: week1-radiology-chest, y3g-week2-medical-imaging-in-paediatrics.",
  },
  "cah-cluster-s1-42-R": {
    name: "Growth charts and centiles",
    evidence: "50 live cards, 2026-09-22. Stored name was Growth · The paediatric history. Twenty-two cards are tagged Growth: mid-parental height, BMI centiles, crossing two centile lines, growth velocity, faltering. The paediatric history is three cards.",
  },
  "cah-cluster-s1-0-L-L-L": {
    name: "Pigmented lesions and neurofibromatosis",
    evidence: "26 live cards, 2026-09-22. Stored name was Dermatology · The naked-eye framework, a section heading. Fronts are café-au-lait, Crowe sign, congenital melanocytic naevus, ugly duckling, plantar warts. Files: pigmented-lesions-melanoma, neurocutaneous-syndromes.",
  },
  "cah-cluster-s1-0-L-R": {
    name: "Impetigo, tinea and scabies",
    evidence: "68 live cards, 2026-09-22. Stored name was Rashes and skin lesions · Dermatology. Files impetigo-sssss (17), tinea-children (10), scabies-children (8). Fronts are golden crust, kerion, nocturnal burrows, school exclusion, SSSS.",
  },
};
