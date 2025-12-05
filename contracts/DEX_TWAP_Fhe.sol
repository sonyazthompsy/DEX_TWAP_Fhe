pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DEX_TWAP_Fhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedAmount;
        uint256 totalEncryptedChunks;
        uint256 startTime;
        uint256 endTime;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => euint32) public encryptedChunkSizes;
    mapping(uint256 => euint32) public encryptedChunkPrices;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId, uint256 startTime);
    event BatchClosed(uint256 indexed batchId, uint256 endTime);
    event EncryptedChunkSubmitted(uint256 indexed batchId, address indexed provider, uint256 chunkIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] cleartexts);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error BatchNotOpen();
    error BatchOpen();
    error ReplayDetected();
    error StateMismatch();
    error InvalidDecryptionProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (isProvider[provider]) revert();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) revert();
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert();
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function openBatch() external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batches[currentBatchId].isOpen) revert BatchOpen();

        currentBatchId++;
        Batch storage batch = batches[currentBatchId];
        batch.id = currentBatchId;
        batch.isOpen = true;
        batch.startTime = block.timestamp;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit BatchOpened(currentBatchId, batch.startTime);
    }

    function closeBatch() external onlyProvider whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert BatchNotOpen();

        Batch storage batch = batches[currentBatchId];
        batch.isOpen = false;
        batch.endTime = block.timestamp;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit BatchClosed(currentBatchId, batch.endTime);
    }

    function submitEncryptedChunk(
        uint256 batchId,
        euint32 encryptedChunkSize,
        euint32 encryptedChunkPrice
    ) external onlyProvider whenNotPaused {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (!batches[batchId].isOpen) revert BatchNotOpen();
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        uint256 chunkIndex = batches[batchId].totalEncryptedChunks;
        encryptedChunkSizes[chunkIndex] = encryptedChunkSize;
        encryptedChunkPrices[chunkIndex] = encryptedChunkPrice;
        batches[batchId].totalEncryptedChunks++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit EncryptedChunkSubmitted(batchId, msg.sender, chunkIndex);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batches[batchId].isOpen) revert BatchOpen();

        uint256 numChunks = batches[batchId].totalEncryptedChunks;
        if (numChunks == 0) revert();

        bytes32[] memory cts = new bytes32[](numChunks * 2);
        for (uint256 i = 0; i < numChunks; i++) {
            cts[i] = encryptedChunkSizes[i].toBytes32();
            cts[i + numChunks] = encryptedChunkPrices[i].toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        uint256 batchId = decryptionContexts[requestId].batchId;
        uint256 numChunks = batches[batchId].totalEncryptedChunks;

        bytes32[] memory currentCts = new bytes32[](numChunks * 2);
        for (uint256 i = 0; i < numChunks; i++) {
            currentCts[i] = encryptedChunkSizes[i].toBytes32();
            currentCts[i + numChunks] = encryptedChunkPrices[i].toBytes32();
        }
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (decryptionContexts[requestId].stateHash != currentStateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            uint256 chunkSizeBytes = 4;
            uint256[] memory decryptedValues = new uint256[](numChunks * 2);
            for (uint256 i = 0; i < numChunks * 2; i++) {
                decryptedValues[i] = uint256(bytes32(cleartexts[i * chunkSizeBytes : (i + 1) * chunkSizeBytes]));
            }

            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, batchId, decryptedValues);
        } catch {
            revert InvalidDecryptionProof();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 e) internal view {
        if (!e.isInitialized()) revert();
    }

    function _requireInitialized(euint32 e) internal view {
        if (!e.isInitialized()) revert();
    }
}