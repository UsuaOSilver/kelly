// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title AllowanceVault
/// @notice Holds a human's USDC and lets one AI agent key spend it only inside a policy:
///         allowlisted payees, a hard daily cap, and an auto-approve limit above which
///         the human owner must approve each payment onchain.
/// @dev    Amounts use the USDC ERC-20 interface (6 decimals). On Arc the same asset is
///         also the native gas token (18 decimals) — this contract never touches native value.
contract AllowanceVault {
    enum Status { None, Pending, Executed, Denied, Expired }

    struct Request {
        address to;
        uint256 amount;
        bytes32 memo;
        uint64 createdAt;
        Status status;
    }

    IERC20 public immutable usdc;
    address public owner;
    address public agent;

    /// @notice Payments at or below this go through without the owner.
    uint256 public autoApproveLimit;
    /// @notice Hard ceiling on total USDC leaving the vault per UTC day. Applies to approved requests too.
    uint256 public dailyCap;
    /// @notice Pending requests older than this can no longer be approved.
    uint64 public constant REQUEST_TTL = 1 hours;

    bool public paused;
    mapping(address => bool) public allowedPayee;

    uint256 public spentInDay;
    uint256 public dayIndex;

    Request[] public requests;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Spent(address indexed to, uint256 amount, bytes32 indexed memo, uint256 requestId, bool ownerApproved);
    event SpendRequested(uint256 indexed requestId, address indexed to, uint256 amount, bytes32 indexed memo);
    event SpendDenied(uint256 indexed requestId);
    event PolicyUpdated(uint256 autoApproveLimit, uint256 dailyCap);
    event PayeeSet(address indexed payee, bool allowed);
    event PausedSet(bool paused);
    event AgentSet(address indexed agent);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error PayeeNotAllowed(address to);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error ZeroAmount();
    error NotPending(uint256 requestId);
    error RequestExpired(uint256 requestId);
    error TransferFailed();

    /// @dev Sentinel used in Spent when the payment was auto-approved and has no request.
    uint256 public constant NO_REQUEST = type(uint256).max;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(IERC20 usdc_, address agent_, uint256 autoApproveLimit_, uint256 dailyCap_) {
        usdc = usdc_;
        owner = msg.sender;
        agent = agent_;
        autoApproveLimit = autoApproveLimit_;
        dailyCap = dailyCap_;
        emit AgentSet(agent_);
        emit PolicyUpdated(autoApproveLimit_, dailyCap_);
    }

    // ───────────────────────────── agent ─────────────────────────────

    /// @notice Agent asks to pay `to`. Small payments execute now; large ones wait for the owner.
    /// @return requestId NO_REQUEST if paid immediately, otherwise the id the owner must approve.
    function spend(address to, uint256 amount, bytes32 memo) external onlyAgent returns (uint256 requestId) {
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();
        if (!allowedPayee[to]) revert PayeeNotAllowed(to);
        // Fail fast: a request that could never fit today's cap is rejected, not queued.
        _checkCap(amount);

        if (amount <= autoApproveLimit) {
            _pay(to, amount);
            emit Spent(to, amount, memo, NO_REQUEST, false);
            return NO_REQUEST;
        }

        requestId = requests.length;
        requests.push(Request(to, amount, memo, uint64(block.timestamp), Status.Pending));
        emit SpendRequested(requestId, to, amount, memo);
    }

    // ───────────────────────────── owner ─────────────────────────────

    function approve(uint256 requestId) external onlyOwner {
        Request storage r = requests[requestId];
        if (r.status != Status.Pending) revert NotPending(requestId);
        if (block.timestamp > r.createdAt + REQUEST_TTL) revert RequestExpired(requestId);
        if (paused) revert IsPaused();
        if (!allowedPayee[r.to]) revert PayeeNotAllowed(r.to);
        _checkCap(r.amount);

        r.status = Status.Executed;
        _pay(r.to, r.amount);
        emit Spent(r.to, r.amount, r.memo, requestId, true);
    }

    function deny(uint256 requestId) external onlyOwner {
        Request storage r = requests[requestId];
        if (r.status != Status.Pending) revert NotPending(requestId);
        r.status = Status.Denied;
        emit SpendDenied(requestId);
    }

    function deposit(uint256 amount) external {
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function setPolicy(uint256 autoApproveLimit_, uint256 dailyCap_) external onlyOwner {
        autoApproveLimit = autoApproveLimit_;
        dailyCap = dailyCap_;
        emit PolicyUpdated(autoApproveLimit_, dailyCap_);
    }

    function setPayee(address payee, bool allowed) external onlyOwner {
        allowedPayee[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    /// @notice Kill switch. While paused the agent cannot spend and requests cannot be approved.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    // ───────────────────────────── views ─────────────────────────────

    function requestCount() external view returns (uint256) {
        return requests.length;
    }

    function spentToday() public view returns (uint256) {
        return block.timestamp / 1 days == dayIndex ? spentInDay : 0;
    }

    function remainingToday() external view returns (uint256) {
        uint256 s = spentToday();
        return s >= dailyCap ? 0 : dailyCap - s;
    }

    // ──────────────────────────── internal ───────────────────────────

    function _checkCap(uint256 amount) internal view {
        uint256 would = spentToday() + amount;
        if (would > dailyCap) revert DailyCapExceeded(would, dailyCap);
    }

    function _pay(address to, uint256 amount) internal {
        uint256 today = block.timestamp / 1 days;
        if (today != dayIndex) {
            dayIndex = today;
            spentInDay = 0;
        }
        spentInDay += amount;
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
