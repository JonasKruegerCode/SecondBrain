# **Architecture of an Autonomous, Self-Improving AI Agent with a Decoupled Hybrid Memory System**

## **1. Architectural Problem Statement and the Vision of the Autonomous Researcher**

Designing an autonomous AI agent that operates as a persistent entity, communicates via Telegram, and independently advances complex hobby projects represents the cutting edge of current AI research. The ambition to create a "virtual employee" that works like an independent researcher — expanding its knowledge, testing hypotheses, and continuously improving itself — frequently fails in practice at a fundamental obstacle: so-called LLM amnesia and the inadequate architecture of integrated memory systems.

Large Language Models (LLMs) are inherently stateless. Each inference cycle treats the input in isolation, meaning all relevant context must be re-injected into the context window with every interaction. Existing agentic frameworks such as OpenClaw or the Hermes Agent offer out-of-the-box solutions for tool use, Telegram integrations, and rudimentary execution loops, but exhibit significant structural deficiencies in long-term memory. The empirical observation that these systems quickly feel like a "dead end" — forgetting information and failing to pursue instructions persistently — is supported by current research findings: the difference between a functional and a dysfunctional agent lies far more often in the memory architecture than in the choice of the underlying language model.

In systems like OpenClaw or conventional heartbeat loops, memory management is handled directly within the agent loop. This leads to cognitive overload of the LLM, as the model is simultaneously responsible for logical reasoning, tool selection, task execution, and state management. The consequence is agents that get stuck in iterative loops and store hallucinations as facts.

To create an agent that collects information, structures knowledge, and expands its own capabilities, the storage architecture must be radically decoupled from the execution loop. The solution lies in a dedicated memory server that serves as an asynchronous cognitive infrastructure. This server must be capable of delivering the perfect context for any incoming message and, in parallel, asynchronously extracting new information and weaving it into a global graph. This report analyzes the state of the art (SOTA) in cognitive architectures for 2024–2026, synthesizes approaches such as GraphRAG, hierarchical vector search, and LLM-managed Markdown wikis (the "Second Brain" paradigm), and delivers a deep, implementable architecture description for such a decoupled system.

## **2. Evolution of Cognitive Architectures and State of the Art**

The evolution of AI memory systems has rapidly progressed from simple vector databases toward hybrid, graph-based, and agentically managed structures. A well-founded architectural decision for building an autonomous researcher requires a deep understanding of the three dominant paradigms that must be fused in the target architecture.

### **2.1 Limitations of Pure Vector Search (Vector RAG)**

Traditional Retrieval-Augmented Generation (RAG) is based on semantic similarity search. Text passages (chunks) are transformed into high-dimensional vectors (embeddings) and retrieved by cosine similarity upon a user query. This paradigm works well for broad searches over unstructured documents, but systematically fails at multi-modal reasoning, temporal dependencies, and causal chains.

A vector system does not understand that one piece of information has made another obsolete, leading to severe contradictions in the context window. If a user tells the agent on Monday that a particular approach to a hobby project is flawed, and asks about its status on Wednesday, the vector search may retrieve outdated text fragments simply because they are mathematically highly similar to the query. Pure vector systems are blind to the relational structure of knowledge and delegate the resolution of contradictions to the probabilistic nature of the LLM, which inevitably leads to non-deterministic behavior.

### **2.2 GraphRAG and Structured Knowledge**

GraphRAG addresses the glaring weaknesses of vector search by modeling knowledge as a formal network of entities (nodes) and their relationships (edges). Instead of retrieving isolated text fragments, GraphRAG uses LLMs during the ingestion phase to extract semantic triples (subject-predicate-object) from conversations and store them in a graph database such as Neo4j.

The immense strength of GraphRAG lies in "multi-hop reasoning." When the autonomous agent is tasked with a complex research task, the system can apply graph-theoretic algorithms (such as K-hop breadth-first search or depth-limited DFS) to find hidden connections that would not be classified as similar in vector space but are logically connected through intermediate nodes. The integration of both systems, often called HybridRAG, fuses the semantic flexibility of vectors with the logical and causal precision of graphs. This is indispensable for an agent working on a project over months, as it must trace causal chains ("Code A causes error B, which leads to solution C").

### **2.3 The LLM-Managed Markdown Wiki (The Karpathy Paradigm)**

A viral and highly effective architectural approach that has revolutionized the "Second Brain" concept was articulated by Andrej Karpathy: instead of merely fragmenting knowledge into databases and re-synthesizing it at runtime, the LLM itself acts as an asynchronous "research librarian" that maintains a persistent, cross-referenced Markdown wiki (in Obsidian style).

The fundamental difference from classical RAG lies in compilation: knowledge is not derived from scratch with every query, but accumulated. When new information arrives from a Telegram chat, the LLM does not merely index it for later retrieval. It reads the information, updates existing entity pages in Markdown format, adjusts topic summaries, and explicitly notes where new data contradicts old claims.

The observation that this model is currently going viral and works surprisingly well can be explained by two factors. First, Markdown is the most native, LLM-friendly, and token-efficient data format, as nearly all major models have been trained on massive amounts of Markdown content (e.g., GitHub). Second, it circumvents the "black box" problem of vector databases. By representing knowledge in simple `.md` files, the agent's brain becomes auditable, human-readable, and manually editable. The wiki becomes a persistent, self-correcting, and growing artifact.

### **2.4 Comparative Analysis of Memory Paradigms**

The following table illustrates the respective properties of the paradigms and justifies the need for fusion in the target architecture:

| Architectural Property | Vector RAG (Semantic Search) | GraphRAG (Knowledge Graphs) | LLM-Managed Markdown Wiki |
| :---- | :---- | :---- | :---- |
| **Primary retrieval mechanism** | Cosine similarity (K-nearest neighbors) | Algorithmic traversal (edges), graph metrics | Filesystem search, index read access |
| **Knowledge storage structure** | Unstructured, isolated text chunks | Formally structured (entities & relations) | Semi-structured, linked text documents |
| **Contradiction resolution** | Very weak (leads to context stuffing) | Strong (via formal overwriting of predicates) | Excellent (LLM actively overwrites file contents) |
| **Cost & latency (read)** | Very low (vector DB query) | Medium to high (traversal + LLM evaluation) | Very low (direct loading into prompt) |
| **Cost & latency (write)** | Low (embedding computation only) | Very high (LLM-based triple extraction) | High (LLM compilation and synthesis) |
| **Multi-hop reasoning** | Weak (blind to causal chains) | Excellent (explicit path traversal) | Good (guided by in-text hyperlinks/wikilinks) |
| **Human readability / auditability** | Very low (number matrices) | Medium (requires graph visualization tools) | Very high (native text format) |

## **3. Fundamental Limitations of Integrated Agent Frameworks**

To understand why approaches like OpenClaw, Hermes Agent, or self-built heartbeat loops are often perceived as dead ends, the role of memory within the agent architecture must be deconstructed.

Modern agent systems like OpenClaw offer excellent runtimes for executing local commands, browsing the web, or interacting with filesystems. The Hermes Agent excels through integrated tools and rudimentary skill creation capabilities. Both systems suffer, however, from the coupling of execution logic and memory management. In these frameworks, the LLM is forced within the same inference cycle to decide which tools to use, how to respond to the user, and which information from the current context to transfer to long-term storage.

The "Memory in the Age of AI Agents" study formalizes this problem within a Partially Observable Markov Decision Process (POMDP) structure. Memory functions here as the agent's internal belief state about a only partially observable world. When the agent does not manage its memory precisely, every downstream decision degrades. Dedicated memory frameworks like Mem0, Letta (formerly MemGPT), or Zep were developed precisely for this reason — to take the cognitive burden off the LLM.

Mem0 excels at extracting user preferences and personalization, Letta uses an OS-like concept of "RAM" (context) and "hard drive" (archive), and Zep focuses on temporal knowledge graphs and extremely low latencies. Nevertheless, as isolated standard products, these systems do not fully meet the complex requirements of an autonomous researcher who needs to maintain Markdown wikis and manage deep hobby projects. The architecture requires a custom, decoupled memory server that strictly separates the "Write-Manage-Read" paradigm into separate, asynchronous processes.

## **4. Conception of the Hybrid "Dual-Sync" Memory Server**

The vision of a system that — similar to GraphRAG — delivers the perfectly matching context for every message, while also modifying it live and extracting knowledge, requires an architecture in which graphs and documents merge. The memory server must stand as an independent instance between the Telegram interface (the user), the agent loop (the execution logic), and the LLM backend (OpenRouter).

### **4.1 Core Infrastructure Components**

The memory server architecture is based on a REST/WebSocket API, preferably implemented in FastAPI for performant management of asynchronous operations. The persistence layer is tripartite:

1. **Graph database (e.g. Neo4j):** Stores formalized knowledge as nodes and edges to represent complex relationship networks and causal chains.
2. **Vector store (e.g. Qdrant or Milvus):** Stores high-dimensional embeddings to enable performant semantic similarity search across all system content.
3. **File system (Obsidian vault):** Acts as the physical storage location for the LLM-managed Markdown wiki. This directory represents the agent's compiled working memory.

### **4.2 The "Dual-Sync" Principle: Merging Graph and Markdown**

The decisive architectural breakthrough lies in the synchronization of the machine-readable knowledge graph with the human-readable Markdown files. When the agent gains a new insight for a hobby project, it is not merely stored as an invisible data point, but manifested in a structured file (e.g. `wiki/project_alpha.md`).

To integrate these files into the graph, **JSON-LD (JavaScript Object Notation for Linked Data)** or structured YAML frontmatter is used. JSON-LD allows semantic triples to be embedded directly in the metadata of Markdown files. Tools like "Neural Composer" or "Obsidian Sync" demonstrate how local `.md` files and GraphRAG can merge seamlessly: textual wikilinks (`[[Concept_A]]`) are automatically translated into directed edges in the Neo4j graph, while frontmatter properties define the attributes of nodes.

This hybrid dual-sync system offers enormous advantages:

* The agent can query the entire graph via Cypher queries to evaluate far-reaching logical connections before making a decision.
* The Markdown files summarized by the LLM serve as extremely compressed, high-quality context that is loaded directly into the system prompt, minimizing token costs and maximizing reasoning accuracy.

## **5. The Hierarchical Memory Structure**

The proposal to map a conversation log hierarchically as topic → conversation summary → conversation corresponds exactly to current research findings on cognitive architectures. Architectures like H-MEM (Hierarchical Memory) or the namespace design in Amazon AgentCore divide memory into specific abstraction layers to resolve the conflict between richness of detail and token efficiency.

The memory system of the autonomous researcher is divided into four logical layers (strata):

### **5.1 Layer 1: The Raw Episodic Log (Raw Transcript)**

The lowest level functions as "sensory memory." Every interaction between user and agent via Telegram is stored precisely and unaltered under a chronological index (e.g. `logs/2026-05-01_conversation.md`). This log serves as an immutable source of truth and as raw material for all subsequent extraction processes. It guarantees complete auditability of the agent's history.

### **5.2 Layer 2: Conversation Summaries (Summary Memory)**

Since directly injecting thousands of raw chat lines into the context window is inefficient and error-prone, the system compresses past sessions. A background process recursively summarizes conversations. These summaries (`summaries/2026-05-01_Summary.md`) aggregate core decisions, expressed user preferences, and open tasks. They link graph-theoretically to the raw log, so the agent can — on demand ("mental time travel") — access the exact quotes without permanently holding the entire text in working memory.

### **5.3 Layer 3: Topic-Specific Entities (Knowledge Graph)**

The third layer completely decouples knowledge from its chronological origin and transfers it into semantic structures. When the user discusses building a drone, the extraction pipeline identifies "drone" as the central entity. Properties, problems, and technical dependencies are manifested as edges in the Neo4j graph (e.g. `-->[Motor_A]`). This layer enables deep relational understanding of hobby projects.

### **5.4 Layer 4: The Compiled System Wiki (Core Context)**

The highest abstraction layer is the LLM-managed wiki. Based on graph entities and summaries, the system automatically generates and updates overarching Markdown documents (e.g. `wiki/Drone_Project_Status.md`). These documents function as persistent "working memory." They always contain the aggregated, error-corrected state of truth and are provided by the memory server as primary context for topic-relevant queries.

## **6. Asynchronous Interfaces and Extraction Pipelines**

The memory server interface must, as proposed, be divided into two fundamental processes: a system that delivers the perfect context for a message (read), and a system that extracts information and manages the graph (write). This separation into a synchronous and an asynchronous path is essential to keep interaction latency on Telegram within a few seconds.

The technical implementation requires an asynchronous web framework like FastAPI in combination with a task queue system like Celery or native FastAPI BackgroundTasks.

### **6.1 Synchronous Path: Real-Time Context Delivery (Read)**

When a message arrives via Telegram, the orchestration layer immediately forwards a call to the memory server (`POST /memory/context`). The goal is to provide the optimal combination of historical knowledge in real time.

The algorithm for this hybrid retrieval goes through the following stages:

1. **Semantic seed matching:** The vector database searches via cosine similarity for the most relevant nodes or Markdown sections thematically matching the current user message.
2. **Graph traversal (multi-hop):** Starting from these identified "seed nodes," the server traverses the graph. Algorithms like K-hop BFS (breadth-first search) or LLM-predicate-filtered beam search follow edges to find entities that are logically, but not necessarily semantically, connected.
3. **Context synthesis:** The identified graph entities and the hierarchically connected wiki files are formatted into a concise context block. This "perfect context" is returned to the agent, which then formulates its response via the OpenRouter API.

### **6.2 Asynchronous Path: Knowledge Extraction and Graph Maintenance (Write)**

Once the agent's response has been sent to the user, the system asynchronously triggers the knowledge extraction endpoint (`POST /memory/ingest`). This process does not block communication and is processed by background workers (Celery).

Knowledge extraction is a demanding LLM task that must be divided into multiple inference steps. To minimize costs, smaller, fast models (like Llama-3-8B, Qwen, or Gemini Flash) are used via OpenRouter. The pipeline prompts the LLM via specific prompts to analyze the last conversation. Incremental prompting ensures the model first identifies entity types and only then extracts relationships, to avoid redundancies in the graph. The extracted knowledge is converted to JSON-LD and synchronized both in Neo4j and in the corresponding Markdown files of the Obsidian vault.

## **7. Deterministic Conflict Resolution in the Knowledge Graph**

The main reason integrated agent memories fail and feel like a "dead end" is their inability to handle contradictory facts. If the user tells the agent on day one "the backend is written in Python" and on day ten "we're switching the backend to Rust," conventional memories collapse. Vector searches retrieve both statements (context stuffing), and the LLM is forced to probabilistically guess the truth. Other systems silently overwrite data, losing history.

To solve this problem at the architecture level, the decoupled memory server implements a formal **assertion model (state machine model)**.

### **7.1 The Assertion Model and Timestamps**

Instead of storing pure text blocks, facts in the graph are represented as typed assertions. Every node and edge mandatorily receives metadata: `{Subject: "Backend_Project", Relation: "programming_language", Object: "Python", Timestamp: "Day_1", Confidence: 0.9, Source: "User_Input"}`.

When new information arrives (`Object: "Rust", Timestamp: "Day_10"`), the conflict detection logic kicks in. The system identifies that the same subject is to be connected via the same relation to a new, exclusive object.

Instead of simply filling the vector database, the system asynchronously creates a "conflict object." The background LLM evaluates this conflict. If it recognizes that this is a legitimate temporal evolution (a change of programming language during the project), the system updates the graph. The old edge is not deleted, but deterministically marked with the attribute `` and persists in the background for the audit trail.

Simultaneously, this triggers a "linting pass." The LLM opens the corresponding Markdown file (`wiki/Backend_Project.md`), revises the text ("Python was originally planned, but the switch was made to Rust"), and recompiles the truth. This deterministic process guarantees that the working memory (layer 4) is always free of contradictions and the agent can act with confidence.

## **8. Autonomous Self-Improvement and Meta-Learning**

An autonomous virtual employee that independently researches and handles hobby projects must have a proactive execution loop. An agent that only reactively responds to Telegram messages remains a glorified chatbot. The architecture therefore requires a heartbeat mechanism and advanced methods of self-improvement.

### **8.1 The Heartbeat and Asynchronous Project Work**

The heartbeat is implemented via an asynchronous scheduler system (e.g. Celery Beat). When the user is not in an active conversation, the agent enters an autonomous background mode. The orchestration engine manages a structured task queue for hobby projects, allocates compute budgets, and triggers the agent to work through open research tasks, compile code, or search the web.

### **8.2 The AutoResearch Ratchet Loop**

To realize the self-improvement demanded by research — without the costly retraining of the LLM's neural network (parameter-free improvement) — the architecture integrates the so-called "ratchet loop." This concept, strongly popularized by Andrej Karpathy's *AutoResearch* project, establishes a safe environment for evolutionary learning.

When the agent attempts to develop a new research strategy for a hobby project or optimize its own system prompt, it operates in an isolated sandbox (e.g. a separate Git branch). The loop follows three steps:

1. **Propose:** The agent analyzes past errors from the log and proposes a change (e.g. a new Python script for data collection or an adapted argumentation chain).
2. **Evaluate:** The system runs an automated test against a measurable objective function, such as the successful execution of unit tests or a reduction of error messages during scraping.
3. **Iterate (Git rollback):** If the result is significantly better, the change is permanently committed to memory. If the result is equivalent or worse, a deterministic rollback mechanism (`git reset`) restores the system to exactly its previous state. Only empirically proven improvements survive this process.

### **8.3 Agent Skills and Progressive Disclosure**

To prevent the context window from overflowing as the number of learned capabilities grows, the system implements "agent skills." Instead of cramming all behavioral rules into a single, monolithic prompt, the agent stores each learned routine as an isolated module in the filesystem (e.g. a folder with a `SKILL.md` file and associated scripts).

The system uses the principle of progressive disclosure: on startup, the agent loads only the name and short description of all available skills into its context. Only when the semantic intent of a user task matches a skill description does the system asynchronously load the full instructions and execute them. This architecture allows the "virtual employee" to build domain-specific expertise over months and manifest it as `SKILL.md`, enabling scalable and modular meta-learning.

## **9. Integration of OpenRouter and Telegram**

The execution layer (interface) functions as the bridge between cognition (the LLMs), memory, and the user. The integration of Telegram and OpenRouter presents specific architectural requirements.

### **9.1 Dynamic Model Routing via OpenRouter**

Using OpenRouter is a critical success factor for an autonomously operating researcher agent, as it enables access to hundreds of models through a single API. This diversity allows dynamic, cost-efficient model routing:

* **Heavy reasoning & orchestration:** For handling complex Telegram queries, orchestrating tools, or evaluation in the ratchet loop (self-improvement), a high-parameter model (e.g. Claude 3.5 Sonnet or DeepSeek V4 Pro) is used.
* **Background extraction & linting:** The permanently running background tasks — such as JSON-LD extraction from chat messages, detecting contradictions, or "linting" (health checks) of the Markdown wiki — require no deep logical analysis. Here, the memory server automatically routes requests to smaller, cost-effective or even free models.

This strict decoupling drastically reduces operating costs and ensures that valuable token budgets are used for genuine cognitive value rather than wasted on administrative memory management.

### **9.2 Telegram as an Asynchronous Frontend**

The connection of the agent to Telegram is mandatory via webhooks to ensure asynchronous user interaction. Synchronous polling would inevitably lead to HTTP timeouts on long-running research tasks.

The architecture provides the following communication flow:

1. The API endpoint (FastAPI) receives the webhook from Telegram, stores the incoming message in the raw episodic log layer, and immediately sends a `202 Accepted` status to the Telegram API to close the connection.
2. An asynchronous Celery worker picks up the task, retrieves the perfect context from the memory server, and initiates research via OpenRouter.
3. Once the final result is available after minutes (or hours), the agent proactively pushes the response to the user via the Telegram Bot API.
4. Simultaneously, the knowledge extraction pipeline starts in the background to permanently integrate the newly generated knowledge into the graph and wiki.

## **10. Summary Architecture Description (The Blueprint)**

To develop the desired "virtual employee" as a robust overall system that overcomes the restrictions of previous frameworks, the following technical topology must be implemented:

**1. The persistence layer (storage infrastructure):**

* **Neo4j (Knowledge Graph):** Stores entities, edges, and assertions (including timestamps and conflict markings) to enable causal multi-hop reasoning.
* **Qdrant / Milvus (Vector Store):** Stores high-dimensional embeddings for fast semantic similarity search as the entry point for graph traversals.
* **Obsidian Vault (File System):** Stores working memory in Markdown format. Files contain YAML frontmatter and JSON-LD for seamless bidirectional synchronization with the Neo4j graph.

**2. The decoupled memory server (FastAPI & Celery):**

* **REST/WebSocket interface:** Encapsulates all memory logic.
* **Endpoint /memory/context (synchronous):** Executes HybridRAG (vector search combined with K-hop BFS graph traversal) and delivers the aggregated Markdown summaries as perfect context for the agent prompt.
* **Endpoint /memory/ingest (asynchronous):** A background task that compresses raw logs into summaries, extracts semantic triples via small LLMs, resolves conflicts through the assertion model, and compiles the Markdown wiki ("Second Brain").

**3. The agent orchestrator (the brain):**

* **Stateless execution engine:** The agent itself has no internal memory, but operates according to the "read-before-reasoning" and "write-after-acting" principle.
* **Heartbeat & task queue:** A scheduler initiates background tasks for hobby projects, even when the user is inactive.
* **Self-improvement module:** A ratchet loop with Git rollback mechanics systematically evaluates code and prompts. Successful iterations are incorporated into the agent's arsenal as persistent `SKILL.md` files via progressive disclosure.

**4. The communication frontend:**

* An asynchronous Telegram webhook receiver that forwards messages to the orchestrator and pushes finished responses back to the user.

The impression that architecturally far more is possible than simple Markdown scripts or monolithic agent frameworks is fully confirmed in this in-depth analysis. By strictly decoupling into an asynchronous memory infrastructure (memory server) and a stateless execution logic (agent loop), a highly modular system emerges.

The synthesis of GraphRAG (for causal, logical reasoning) and the Karpathy LLM wiki principle (for persistent, human-readable, compiled knowledge representation) eliminates the problem of LLM amnesia. Supplemented by a formal assertion model for deterministic contradiction resolution and the AutoResearch ratchet loop for continuous learning, the vision transforms into an intelligent, proactive entity. An agent constructed this way fulfills the requirement to manage complex hobby projects as an autonomous "virtual employee" — flawlessly and with unlimited memory.
