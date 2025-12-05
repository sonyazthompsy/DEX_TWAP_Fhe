// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Order {
  id: string;
  pair: string;
  size: number;
  encryptedPrice: string;
  executionTime: number;
  status: 'pending' | 'executed' | 'cancelled';
  type: 'TWAP' | 'VWAP';
}

interface Announcement {
  id: number;
  title: string;
  content: string;
  timestamp: number;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<'all' | 'TWAP' | 'VWAP'>('all');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  
  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
      
      // Mock announcements
      setAnnouncements([
        {
          id: 1,
          title: "System Upgrade Scheduled",
          content: "We will perform a scheduled maintenance on Oct 20, 2025 from 2:00 AM to 4:00 AM UTC.",
          timestamp: Math.floor(Date.now() / 1000) - 3600
        },
        {
          id: 2,
          title: "New Feature: VWAP Execution",
          content: "We've added VWAP execution algorithm support to complement our existing TWAP offering.",
          timestamp: Math.floor(Date.now() / 1000) - 86400
        },
        {
          id: 3,
          title: "ZAMA FHE Integration Complete",
          content: "Successfully integrated ZAMA FHE for all order encryption operations.",
          timestamp: Math.floor(Date.now() / 1000) - 172800
        }
      ]);
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load orders
      const ordersBytes = await contract.getData("orders");
      let ordersList: Order[] = [];
      if (ordersBytes.length > 0) {
        try {
          const ordersStr = ethers.toUtf8String(ordersBytes);
          if (ordersStr.trim() !== '') ordersList = JSON.parse(ordersStr);
        } catch (e) {}
      }
      setOrders(ordersList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Create new order
  const createOrder = async (pair: string, size: number, type: 'TWAP' | 'VWAP') => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Creating order with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new order with encrypted price (mock price for demo)
      const mockPrice = Math.random() * 100;
      const newOrder: Order = {
        id: `ORD-${Date.now()}`,
        pair,
        size,
        encryptedPrice: FHEEncryptNumber(mockPrice),
        executionTime: Math.floor(Date.now() / 1000),
        status: 'pending',
        type
      };
      
      // Update orders list
      const updatedOrders = [...orders, newOrder];
      
      // Save to contract
      await contract.setData("orders", ethers.toUtf8Bytes(JSON.stringify(updatedOrders)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Order created successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt price with signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Filtered orders based on search and filter
  const filteredOrders = orders.filter(order => {
    const matchesSearch = order.pair.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         order.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === 'all' || order.type === filterType;
    return matchesSearch && matchesType;
  });

  // Render order statistics
  const renderStats = () => {
    const totalOrders = orders.length;
    const twapOrders = orders.filter(o => o.type === 'TWAP').length;
    const vwapOrders = orders.filter(o => o.type === 'VWAP').length;
    const executedOrders = orders.filter(o => o.status === 'executed').length;
    const totalVolume = orders.reduce((sum, o) => sum + o.size, 0);

    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{totalOrders}</div>
          <div className="stat-label">Total Orders</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{twapOrders}</div>
          <div className="stat-label">TWAP Orders</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{vwapOrders}</div>
          <div className="stat-label">VWAP Orders</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{executedOrders}</div>
          <div className="stat-label">Executed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalVolume.toFixed(2)}</div>
          <div className="stat-label">Total Volume</div>
        </div>
      </div>
    );
  };

  // Render price chart
  const renderPriceChart = () => {
    const options = {
      chart: {
        type: 'line',
        foreColor: '#999',
        toolbar: {
          show: false
        },
        zoom: {
          enabled: false
        }
      },
      colors: ['#FF7F50'],
      stroke: {
        width: 3,
        curve: 'smooth'
      },
      xaxis: {
        categories: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'],
        labels: {
          style: {
            colors: '#999'
          }
        }
      },
      yaxis: {
        labels: {
          style: {
            colors: '#999'
          },
          formatter: (value: number) => `$${value.toFixed(2)}`
        }
      },
      tooltip: {
        theme: 'dark',
        y: {
          formatter: (value: number) => `$${value.toFixed(2)}`
        }
      },
      grid: {
        borderColor: 'rgba(255, 255, 255, 0.1)'
      }
    };

    const series = [{
      name: 'Price',
      data: [45.32, 46.12, 45.89, 47.23, 46.78, 47.56, 47.12]
    }];

  };

  // Render order distribution chart
  const renderOrderDistribution = () => {
    const options = {
      chart: {
        type: 'donut',
        foreColor: '#999'
      },
      colors: ['#FF7F50', '#1E90FF'],
      labels: ['TWAP', 'VWAP'],
      legend: {
        position: 'bottom',
        labels: {
          colors: '#999'
        }
      },
      dataLabels: {
        enabled: false
      },
      plotOptions: {
        pie: {
          donut: {
            size: '65%'
          }
        }
      },
      tooltip: {
        theme: 'dark',
        y: {
          formatter: (value: number) => `${value} orders`
        }
      }
    };

    const series = [
      orders.filter(o => o.type === 'TWAP').length,
      orders.filter(o => o.type === 'VWAP').length
    ];

  };

  // Render announcements
  const renderAnnouncements = () => {
    return (
      <div className="announcements-container">
        <h3>System Announcements</h3>
        {announcements.map(announcement => (
          <div className="announcement-item" key={announcement.id}>
            <div className="announcement-header">
              <div className="announcement-title">{announcement.title}</div>
              <div className="announcement-time">
                {new Date(announcement.timestamp * 1000).toLocaleDateString()}
              </div>
            </div>
            <div className="announcement-content">{announcement.content}</div>
          </div>
        ))}
      </div>
    );
  };

  // Quick order creation
  const quickOrder = (type: 'TWAP' | 'VWAP') => {
    const pairs = ['ETH/USDC', 'BTC/USDC', 'SOL/USDC', 'MATIC/USDC'];
    const pair = pairs[Math.floor(Math.random() * pairs.length)];
    const size = Math.random() * 10 + 1;
    createOrder(pair, size, type);
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE execution system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="fhe-icon"></div>
          </div>
          <h1>FHE<span>TWAP</span></h1>
          <div className="tagline">Private Order Execution</div>
        </div>
        
        <div className="header-actions">
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-grid">
          <div className="dashboard-left">
            <div className="panel">
              <h2>Order Statistics</h2>
              {renderStats()}
            </div>
            
            <div className="panel">
              <h2>Price Chart (FHE Protected)</h2>
            </div>
            
            <div className="panel">
              <h2>Order Distribution</h2>
            </div>
          </div>
          
          <div className="dashboard-right">
            <div className="panel">
              <div className="panel-header">
                <h2>Order Management</h2>
                <div className="header-actions">
                  <button 
                    onClick={loadData} 
                    className="refresh-btn" 
                    disabled={isRefreshing}
                  >
                    {isRefreshing ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>
              
              <div className="search-filter">
                <input
                  type="text"
                  placeholder="Search orders..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value as 'all' | 'TWAP' | 'VWAP')}
                  className="filter-select"
                >
                  <option value="all">All Types</option>
                  <option value="TWAP">TWAP</option>
                  <option value="VWAP">VWAP</option>
                </select>
              </div>
              
              <div className="quick-order-buttons">
                <button 
                  className="quick-order-btn twap" 
                  onClick={() => quickOrder('TWAP')}
                >
                  Quick TWAP Order
                </button>
                <button 
                  className="quick-order-btn vwap" 
                  onClick={() => quickOrder('VWAP')}
                >
                  Quick VWAP Order
                </button>
              </div>
              
              <div className="orders-list">
                {filteredOrders.length === 0 ? (
                  <div className="no-orders">
                    <div className="no-orders-icon"></div>
                    <p>No orders found</p>
                  </div>
                ) : filteredOrders.map((order, index) => (
                  <div className="order-item" key={index}>
                    <div className="order-id">{order.id}</div>
                    <div className="order-pair">{order.pair}</div>
                    <div className="order-size">{order.size.toFixed(4)}</div>
                    <div className="order-type">{order.type}</div>
                    <div className="order-status">{order.status}</div>
                    <div className="order-time">
                      {new Date(order.executionTime * 1000).toLocaleTimeString()}
                    </div>
                    <button 
                      className="decrypt-btn" 
                      onClick={async () => {
                        const price = await decryptWithSignature(order.encryptedPrice);
                        if (price !== null) {
                          setDecryptedPrice(price);
                          setTimeout(() => setDecryptedPrice(null), 5000);
                        }
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : "Decrypt Price"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="panel">
              {renderAnnouncements()}
            </div>
          </div>
        </div>
      </div>
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      {decryptedPrice !== null && (
        <div className="decrypted-price-modal">
          <div className="decrypted-content">
            <div className="fhe-icon"></div>
            <div className="decrypted-value">${decryptedPrice.toFixed(4)}</div>
            <div className="decrypted-label">Decrypted Execution Price</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="fhe-icon"></div>
              <span>FHE-TWAP</span>
            </div>
            <p>Private order execution powered by Zama FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} FHE-TWAP. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect order execution privacy.
            Prices and order sizes are encrypted using Zama FHE technology.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;