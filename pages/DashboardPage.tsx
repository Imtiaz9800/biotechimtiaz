import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../hooks/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/Card';
import { DollarSign, Package, Users, FileText, AlertTriangle, ArrowRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatCurrency } from '../hooks/lib/utils';
import Skeleton from '../components/ui/Skeleton';
import { Link } from 'react-router-dom';
import HealthMonitor from '../components/HealthMonitor';

const fetchDashboardStats = async () => {
  // Parallel queries for performance
  const invoicesPromise = supabase.from('invoices').select('total_amount, invoice_date', { count: 'exact' });
  const customersPromise = supabase.from('customers').select('*', { count: 'exact', head: true }).eq('is_guest', false);
  const productsPromise = supabase.from('products').select('stock_quantity');
  
  // Fetch purchases to calculate estimated purchase value
  // Note: Since we don't store purchase price, we estimate using current product unit_price
  const purchasesPromise = supabase.from('purchases').select('purchase_date, quantity, products(unit_price)');
  
  // Fetch out of stock products (removed limit to show all)
  const outOfStockPromise = supabase
    .from('products')
    .select('id, name, stock_quantity, units(abbreviation)')
    .lte('stock_quantity', 0)
    .order('name');

  const [
    { data: invoices, error: invoicesError, count: invoiceCount },
    { count: customerCount, error: customersError },
    { data: products, error: productsError },
    { data: purchases, error: purchasesError },
    { data: outOfStockProducts, error: outOfStockError }
  ] = await Promise.all([
    invoicesPromise, 
    customersPromise, 
    productsPromise, 
    purchasesPromise,
    outOfStockPromise
  ]);

  if (invoicesError) throw invoicesError;
  if (customersError) throw customersError;
  if (productsError) throw productsError;
  if (purchasesError) throw purchasesError;
  if (outOfStockError) throw outOfStockError;

  // --- Client-side data processing ---
  const totalRevenue = (invoices || []).reduce((sum, inv) => sum + inv.total_amount, 0);
  const productsInStock = (products || []).reduce((sum, prod) => sum + (Number(prod.stock_quantity) || 0), 0);

  // Initialize data for the last 12 months for the chart
  const chartData = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const today = new Date();
  
  // Loop for 12 months
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    chartData.push({ 
        name: monthNames[d.getMonth()],
        year: d.getFullYear(),
        monthIndex: d.getMonth(),
        Sales: 0,
        Purchases: 0
    });
  }

  const cutoffDate = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  cutoffDate.setHours(0,0,0,0);

  // Aggregate sales data by month
  (invoices || []).forEach(invoice => {
    const invoiceDate = new Date(invoice.invoice_date);
    
    if (invoiceDate >= cutoffDate) {
      const bucket = chartData.find(d => d.monthIndex === invoiceDate.getMonth() && d.year === invoiceDate.getFullYear());
      if (bucket) {
        bucket.Sales += invoice.total_amount;
      }
    }
  });

  // Aggregate purchase data by month
  (purchases || []).forEach((purchase: any) => {
    const purchaseDate = new Date(purchase.purchase_date);
    
    if (purchaseDate >= cutoffDate) {
      const bucket = chartData.find(d => d.monthIndex === purchaseDate.getMonth() && d.year === purchaseDate.getFullYear());
      if (bucket) {
        // Estimate value: quantity * current unit_price (since cost isn't tracked)
        const price = purchase.products?.unit_price || 0;
        bucket.Purchases += (purchase.quantity * price);
      }
    }
  });

  return {
    totalRevenue,
    totalInvoices: invoiceCount || 0,
    activeCustomers: customerCount || 0,
    productsInStock,
    chartData,
    outOfStockProducts: outOfStockProducts || [],
  };
};

const DashboardPage: React.FC = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboardStats'],
    queryFn: fetchDashboardStats,
  });

  const StatCardSkeleton: React.FC = () => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-7 w-1/2 mb-2" />
        <Skeleton className="h-3 w-1/3" />
      </CardContent>
    </Card>
  );

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 p-3 border border-gray-100 dark:border-gray-700 shadow-xl rounded-xl">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
             <div key={index} className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                <span className="text-sm font-medium text-gray-600 dark:text-gray-300">{entry.name}:</span>
                <span className="text-sm font-bold ml-auto" style={{ color: entry.color }}>
                   {formatCurrency(entry.value)}
                </span>
             </div>
          ))}
        </div>
      );
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-600 bg-clip-text text-transparent">Dashboard</h1>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2 bg-gradient-to-b from-white to-slate-50">
            <CardHeader><CardTitle>Sales Overview</CardTitle></CardHeader>
            <CardContent>
                <div className="h-80 flex items-center justify-center">
                <Skeleton className="h-full w-full" />
                </div>
            </CardContent>
            </Card>
             <Card className="lg:col-span-1">
                <CardHeader><CardTitle>Out of Stock</CardTitle></CardHeader>
                <CardContent>
                    <Skeleton className="h-40 w-full" />
                </CardContent>
             </Card>
        </div>
      </div>
    );
  }

  if (error) {
      return (
          <div className="flex items-center justify-center h-full">
              <Card className="p-6">
                  <CardTitle>Error</CardTitle>
                  <CardContent>
                      <p className="text-red-500 mt-4">Failed to load dashboard data: {error instanceof Error ? error.message : 'An unknown error occurred'}</p>
                  </CardContent>
              </Card>
          </div>
      );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-600 bg-clip-text text-transparent">Dashboard</h1>
      </div>
      
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        <div className="md:col-span-2 lg:col-span-1">
            <HealthMonitor />
        </div>
      </div>
      
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <div className="p-2 bg-gradient-to-tr from-blue-500 to-cyan-400 rounded-lg shadow-md">
              <DollarSign className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(data?.totalRevenue ?? 0)}</div>
            <p className="text-xs text-muted-foreground">From all invoices</p>
          </CardContent>
        </Card>
         <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Invoices</CardTitle>
            <div className="p-2 bg-gradient-to-tr from-purple-500 to-pink-400 rounded-lg shadow-md">
                <FileText className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.totalInvoices ?? 0}</div>
            <p className="text-xs text-muted-foreground">Across all customers</p>
          </CardContent>
        </Card>
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Customers</CardTitle>
            <div className="p-2 bg-gradient-to-tr from-teal-500 to-lime-400 rounded-lg shadow-md">
                <Users className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.activeCustomers ?? 0}</div>
            <p className="text-xs text-muted-foreground">Excluding guest checkouts</p>
          </CardContent>
        </Card>
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Products in Stock</CardTitle>
             <div className="p-2 bg-gradient-to-tr from-amber-500 to-orange-400 rounded-lg shadow-md">
                <Package className="h-4 w-4 text-white" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.productsInStock ?? 0}</div>
            <p className="text-xs text-muted-foreground">Sum of all product quantities</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-none shadow-sm ring-1 ring-slate-200 dark:ring-gray-700 bg-gradient-to-b from-white to-slate-50 dark:from-gray-800 dark:to-gray-800/50">
            <CardHeader>
              <CardTitle>Sales & Purchases Overview (Last 12 Months)</CardTitle>
            </CardHeader>
            <CardContent>
            <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.chartData} margin={{ top: 20, right: 0, left: -20, bottom: 0 }}>
                <defs>
                    <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#818cf8" stopOpacity={1}/>
                        <stop offset="100%" stopColor="#c7d2fe" stopOpacity={0.2}/>
                    </linearGradient>
                    <linearGradient id="colorPurchases" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4ade80" stopOpacity={1}/>
                        <stop offset="100%" stopColor="#bbf7d0" stopOpacity={0.2}/>
                    </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                    dataKey="name" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }}
                    dy={10}
                />
                <YAxis 
                    allowDecimals={false}
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }}
                    tickFormatter={(value) => {
                        if (value === 0) return '₹0';
                        return `₹${value >= 1000 ? (value / 1000).toFixed(1) + 'k' : value}`;
                    }}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f8fafc', opacity: 0.5 }} />
                <Legend iconType="circle" />
                <Bar 
                    dataKey="Sales" 
                    fill="url(#colorSales)" 
                    radius={[4, 4, 0, 0]} 
                    barSize={20}
                    animationDuration={1500}
                />
                <Bar 
                    dataKey="Purchases" 
                    fill="url(#colorPurchases)" 
                    radius={[4, 4, 0, 0]} 
                    barSize={20}
                    animationDuration={1500}
                />
                </BarChart>
            </ResponsiveContainer>
            </div>
            </CardContent>
        </Card>

        <Card className="lg:col-span-1 border-red-100 dark:border-red-900/50 flex flex-col h-full">
            <CardHeader className="pb-3 shrink-0">
                <CardTitle className="flex items-center text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-5 h-5 mr-2" />
                    Out of Stock
                </CardTitle>
                <CardDescription>Products that need restocking immediately.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 overflow-hidden flex flex-col">
                {data?.outOfStockProducts && data.outOfStockProducts.length > 0 ? (
                    <div className="flex flex-col h-full">
                        <div className="space-y-3 overflow-y-auto max-h-[320px] pr-2 custom-scrollbar">
                            {data.outOfStockProducts.map((product: any) => (
                                <Link 
                                    key={product.id} 
                                    to={`/stock/${product.id}`}
                                    className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-lg border border-red-100 dark:border-red-900/30 transition-colors group"
                                >
                                    <div>
                                        <p className="font-medium text-sm text-gray-900 dark:text-gray-100">{product.name}</p>
                                        <p className="text-xs text-red-600 dark:text-red-400 font-bold mt-0.5">
                                            0 {product.units?.abbreviation}
                                        </p>
                                    </div>
                                    <ArrowRight className="w-4 h-4 text-blue-500 dark:text-blue-400 opacity-70 group-hover:opacity-100 transition-opacity transform group-hover:translate-x-1" />
                                </Link>
                            ))}
                        </div>
                        <div className="pt-4 mt-auto">
                            <Link to="/stock" className="block text-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300">
                                View all stock
                            </Link>
                        </div>
                    </div>
                ) : (
                    <div className="text-center py-12 text-gray-500 dark:text-gray-400 h-full flex flex-col justify-center">
                        <Package className="w-12 h-12 mx-auto mb-3 opacity-20" />
                        <p>All products are in stock.</p>
                    </div>
                )}
            </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default DashboardPage;