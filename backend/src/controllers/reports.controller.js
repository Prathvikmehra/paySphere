const PDFDocument = require("pdfkit");
const PayrollUpdate = require("../models/payroll.model");
const Employee = require("../models/employee.model");

// GET /api/reports/analytics
// Returns aggregated financial stats for the authenticated user's company
exports.getAnalytics = async (req, res, next) => {
  try {
    const userId = req.userId;
    const monthsBack = Math.min(parseInt(req.query.months) || 6, 12);

    // Calculate date range
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

    // MongoDB Aggregation Pipeline for Monthly Trends
    const monthlyTrendsAgg = await PayrollUpdate.aggregate([
      {
        $match: {
          createdBy: new require("mongoose").Types.ObjectId(userId),
          $or: [
            { year: { $gt: startDate.getFullYear() } },
            {
              year: startDate.getFullYear(),
              month: { $gte: startDate.getMonth() + 1 },
            },
          ],
        },
      },
      {
        $group: {
          _id: { year: "$year", month: "$month" },
          totalPayout: { $sum: "$netSalary" },
          totalBase: { $sum: "$baseSalary" },
          totalOvertime: { $sum: "$overtimePay" },
          totalBonus: { $sum: "$bonus" },
          totalDeductions: { $sum: { $add: ["$deductions", "$leaveDeduction"] } },
          employeeCount: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 },
      },
    ]);

    const monthlyTrends = monthlyTrendsAgg.map((item) => ({
      month: item._id.month,
      year: item._id.year,
      label: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
      totalPayout: item.totalPayout,
      totalBase: item.totalBase,
      totalOvertime: item.totalOvertime,
      totalBonus: item.totalBonus,
      totalDeductions: item.totalDeductions,
      employeeCount: item.employeeCount,
    }));

    // Aggregation Pipeline for Role Breakdown
    const roleBreakdownAgg = await PayrollUpdate.aggregate([
      {
        $match: {
          createdBy: new require("mongoose").Types.ObjectId(userId),
        },
      },
      {
        $lookup: {
          from: "employees",
          localField: "employeeId",
          foreignField: "_id",
          as: "employeeInfo",
        },
      },
      {
        $unwind: { path: "$employeeInfo", preserveNullAndEmptyArrays: true },
      },
      {
        $group: {
          _id: { $ifNull: ["$employeeInfo.role", "Unassigned"] },
          totalPayout: { $sum: "$netSalary" },
          totalBase: { $sum: "$baseSalary" },
          totalOvertime: { $sum: "$overtimePay" },
          employeeCount: { $sum: 1 },
        },
      },
      {
        $sort: { totalPayout: -1 },
      },
    ]);

    const roleBreakdown = roleBreakdownAgg.map((item) => ({
      role: item._id,
      totalPayout: item.totalPayout,
      totalBase: item.totalBase,
      totalOvertime: item.totalOvertime,
      employeeCount: item.employeeCount,
    }));

    // Overall Summary
    const summaryAgg = await PayrollUpdate.aggregate([
      {
        $match: {
          createdBy: new require("mongoose").Types.ObjectId(userId),
        },
      },
      {
        $group: {
          _id: null,
          totalPayout: { $sum: "$netSalary" },
          totalBase: { $sum: "$baseSalary" },
          totalOvertime: { $sum: "$overtimePay" },
          totalBonus: { $sum: "$bonus" },
          totalDeductions: { $sum: { $add: ["$deductions", "$leaveDeduction"] } },
          totalRecords: { $sum: 1 },
        },
      },
    ]);

    const overallSummary = summaryAgg[0] || {
      totalPayout: 0,
      totalBase: 0,
      totalOvertime: 0,
      totalBonus: 0,
      totalDeductions: 0,
      totalRecords: 0,
    };

    res.status(200).json({
      summary: {
        totalPayout: overallSummary.totalPayout,
        totalBase: overallSummary.totalBase,
        totalOvertime: overallSummary.totalOvertime,
        totalBonus: overallSummary.totalBonus,
        totalDeductions: overallSummary.totalDeductions,
        totalRecords: overallSummary.totalRecords,
        monthsCovered: monthlyTrends.length,
      },
      monthlyTrends,
      roleBreakdown,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/reports/download-pdf?month=&year=
// Generates and returns a downloadable company-wide PDF summary report
exports.downloadPDFReport = async (req, res, next) => {
  try {
    const userId = req.userId;
    let month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;
    let year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

    if (isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Invalid month parameter" });
    }
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year parameter" });
    }

    // Fetch payroll records for the selected month
    const payrolls = await PayrollUpdate.find({
      createdBy: userId,
      month,
      year,
    }).sort({ employeeName: 1 });

    if (payrolls.length === 0) {
      return res
        .status(404)
        .json({ message: "No payroll data found for the selected period." });
    }

    // Fetch employee details for roles
    const employeeIds = payrolls.map((p) => p.employeeId);
    const employees = await Employee.find({ _id: { $in: employeeIds } });
    const employeeMap = {};
    employees.forEach((emp) => {
      employeeMap[String(emp._id)] = emp;
    });

    // Get company name from first employee
    const companyName =
      employees.length > 0 ? employees[0].companyName : "PaySphere";

    // Month names for display
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const monthName = monthNames[month - 1];

    // --- Summary Section ---
    const totalPayout = payrolls.reduce((sum, p) => sum + p.netSalary, 0);
    const totalBase = payrolls.reduce((sum, p) => sum + p.baseSalary, 0);
    const totalOvertime = payrolls.reduce((sum, p) => sum + p.overtimePay, 0);
    const totalBonus = payrolls.reduce((sum, p) => sum + p.bonus, 0);
    const totalDeductions = payrolls.reduce(
      (sum, p) => sum + p.deductions + p.leaveDeduction,
      0,
    );

    const { Worker } = require("worker_threads");
    const path = require("path");

    const pdfWorker = new Worker(path.join(__dirname, "../workers/pdf.worker.js"));
    
    pdfWorker.postMessage({
      type: "GENERATE_COMPANY_REPORT",
      payload: {
        payrolls,
        employeeMap,
        companyName,
        monthName,
        year,
        totalBase,
        totalOvertime,
        totalBonus,
        totalDeductions,
        totalPayout
      }
    });

    pdfWorker.on("message", (result) => {
      if (result.success) {
        // Set response headers for PDF download
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=payroll-report-${monthName}-${year}.pdf`,
        );
        res.send(Buffer.from(result.pdfData));
      } else {
        next(new Error("Failed to generate PDF: " + result.error));
      }
      pdfWorker.terminate();
    });

    pdfWorker.on("error", (err) => {
      next(err);
      pdfWorker.terminate();
    });
  } catch (error) {
    next(error);
  }
};
